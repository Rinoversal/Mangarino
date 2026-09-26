"""The Windows app around the hub.

- Its own window (Microsoft Edge WebView2, part of Windows 10 and 11), with the hub's page in
  it. Without WebView2, the page opens in an Edge app window or the browser instead.
- A tray icon: closing the window keeps the hub running there, so devices can still sync.
- One copy at a time. Starting it again shows the running window. Starting a newer version
  stops the older one and takes over.
- Optionally starts with Windows, in the tray (for the .exe only).
- No console: what the hub reports goes to hub.log in %APPDATA%\\Mangarino.
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from . import BUILD, VERSION, brand

APP_NAME = brand.HUB
APP_ID = brand.APP_ID  # also on the Start menu shortcut the installer makes
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
WINDOW_BG = "#060b1e"  # matches --bg in web/style.css, so the window never flashes white
TITLE_TEXT = "#e9ecff"
LOG_MAX_BYTES = 1_000_000


# ---------------------------------------------------------------------- log file
class LogFile:
    """Timestamped lines to hub.log (and to the console when there is one)."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        try:
            if path.exists() and path.stat().st_size > LOG_MAX_BYTES:
                os.replace(path, path.with_suffix(".old.log"))
        except OSError:
            pass

    def __call__(self, msg: str = "") -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}" if msg else ""
        if sys.stdout is not None:
            try:
                print(msg, flush=True)
            except (OSError, ValueError):
                pass
        with self.lock:
            try:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass


def message_box(text: str, error: bool = False) -> None:
    """A plain Windows message, for when there's no window to show it in."""
    if os.name != "nt":
        print(text)
        return
    try:
        ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x10 if error else 0x40)
    except (OSError, AttributeError):
        pass


# ---------------------------------------------------------------------- one copy at a time
def instance_file(config_path: Path) -> Path:
    """Where the running hub leaves its process id, port and admin key (only this Windows user
    can read it), so a second start can show its window or hand over to a newer version."""
    return Path(config_path).with_name("hub-instance.json")


def write_instance(path: Path, port: int, key: str) -> None:
    data = {"pid": os.getpid(), "port": port, "key": key, "version": VERSION, "build": BUILD}
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def clear_instance(path: Path) -> None:
    try:
        if json.loads(path.read_text(encoding="utf-8")).get("pid") == os.getpid():
            path.unlink()
    except (OSError, ValueError):
        pass


def _request(port: int, path: str, key: str | None = None, body: dict | None = None, timeout: float = 4.0) -> bytes | None:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST" if body is not None else "GET")
    if key:
        req.add_header("X-Admin-Key", key)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.read()
    except (urllib.error.URLError, OSError, ValueError):
        return None


def running_hub(port: int) -> dict | None:
    raw = _request(port, "/api/hello", timeout=2.0)
    try:
        info = json.loads(raw or b"")
    except ValueError:
        return None
    return info if isinstance(info, dict) and info.get("service") == "mangarino-hub" else None


def _admin_key(port: int, instance: Path) -> str | None:
    try:
        data = json.loads(instance.read_text(encoding="utf-8"))
        if data.get("port") == port and data.get("key"):
            return str(data["key"])
    except (OSError, ValueError):
        pass
    # Hubs from before this file existed put the key in their own page (served to this PC only).
    page = _request(port, "/") or b""
    m = re.search(rb'name="admin-key" content="([A-Za-z0-9_-]{16,})"', page)
    return m.group(1).decode("ascii") if m else None


def version_key(version: str, build: int = 0) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", str(version))[:3]) + (int(build or 0),)


def allow_foreground() -> None:
    """Let the running hub bring its window to the front (Windows only lets the program the user
    just started do that, so it passes the right on)."""
    try:
        ctypes.windll.user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
    except (OSError, AttributeError):
        pass


def hand_over(port: int, instance: Path, log) -> str:
    """Another program holds the hub's port. Returns:
    - "shown": it's this version or newer; its window was brought up, so this copy should exit
    - "stopped": it was an older hub and has stopped; this copy should start
    - "foreign": it isn't a hub, or an older hub that couldn't be stopped
    """
    other = running_hub(port)
    if other is None or other.get("brand", "Mangarino") != brand.NAME:
        return "foreign"  # nothing we know, or the other edition (Mangarino / Testarino)
    key = _admin_key(port, instance)
    if version_key(other.get("version", "0"), other.get("build", 0)) >= version_key(VERSION, BUILD):
        allow_foreground()
        answer = _request(port, "/admin/show", key, {}) if key else None
        try:
            shown = bool(json.loads(answer or b"{}").get("ok"))
        except ValueError:
            shown = False
        if not shown:
            webbrowser.open(f"http://127.0.0.1:{port}/")  # a hub without a window of its own
        return "shown"
    if key is None:
        return "foreign"
    log(f"Stopping {APP_NAME} {other.get('version')} so this newer version can take over.")
    _request(port, "/admin/stop", key, {})
    for _ in range(60):
        time.sleep(0.25)
        if running_hub(port) is None:
            time.sleep(0.5)  # let it close its socket
            return "stopped"
    return "foreign"


def _wait_for_exit(pid: int, timeout_s: float) -> bool:
    """Wait for a process to end (its files stay locked until then). True when it has."""
    if os.name != "nt" or not pid or pid == os.getpid():
        return True
    try:
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x00100000, False, int(pid))  # SYNCHRONIZE
        if not handle:
            return True  # already gone
        try:
            return k32.WaitForSingleObject(handle, int(timeout_s * 1000)) == 0  # WAIT_OBJECT_0
        finally:
            k32.CloseHandle(handle)
    except (OSError, AttributeError):
        return True


def stop_running(port: int, instance: Path) -> bool:
    """Stop a running hub (for the installer and uninstaller): True once it has exited, so its
    files can be replaced or deleted."""
    pid = 0
    try:
        data = json.loads(instance.read_text(encoding="utf-8"))
        port = int(data.get("port") or port)
        pid = int(data.get("pid") or 0)
    except (OSError, ValueError):
        pass
    if running_hub(port) is None:
        return _wait_for_exit(pid, 10)  # may still be closing its window
    key = _admin_key(port, instance)
    if key is None:
        return False
    _request(port, "/admin/stop", key, {})
    for _ in range(60):
        time.sleep(0.25)
        if running_hub(port) is None:
            return _wait_for_exit(pid, 15)
    return False


def set_app_id() -> None:
    """One identity for the window, taskbar button and notifications ("Mangarino Hub", not Python)."""
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except (OSError, AttributeError):
        pass


# ---------------------------------------------------------------------- start with Windows
def autostart_supported() -> bool:
    return os.name == "nt" and bool(getattr(sys, "frozen", False))


def _autostart_command() -> str:
    return f'"{sys.executable}" --background'


def autostart_enabled() -> bool:
    if not autostart_supported():
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            value, _ = winreg.QueryValueEx(k, APP_NAME)
        return str(value).strip().lower() == _autostart_command().lower()
    except OSError:
        return False


def set_autostart(on: bool) -> bool:
    if not autostart_supported():
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            if on:
                winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, _autostart_command())
            else:
                try:
                    winreg.DeleteValue(k, APP_NAME)
                except FileNotFoundError:
                    pass
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------- windows without WebView2
def _edge() -> str | None:
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LocalAppData")):
        if base:
            exe = Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
            if exe.is_file():
                return str(exe)
    return None


def open_app_window(url: str) -> None:
    """An Edge window with just the page (no tabs or address bar); the browser if there's no Edge."""
    edge = _edge()
    if edge:
        try:
            subprocess.Popen([edge, f"--app={url}"], close_fds=True)
            return
        except OSError:
            pass
    webbrowser.open(url)


def _dwm_attr(hwnd: int, attr: int, value: int) -> None:
    try:
        v = ctypes.c_int(value)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(ctypes.c_void_p(hwnd), attr, ctypes.byref(v), 4)
    except (OSError, AttributeError):
        pass


def _colorref(hex_color: str) -> int:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r | (g << 8) | (b << 16)


# ---------------------------------------------------------------------- the app
class DesktopApp:
    def __init__(self, hub, url: str, log, log_path: Path, background: bool = False):
        self.hub, self.url, self.log, self.log_path = hub, url, log, log_path
        self.background = background
        self.window = None
        self.icon = None
        self.windowed = False  # True once our own WebView2 window is up
        self.quitting = False
        self.told_about_tray = background
        hub.desktop = self

    # -------------------------------------------------- for the hub and its page
    def info(self) -> dict:
        return {
            "window": self.windowed,
            "autostart": autostart_enabled(),
            "canAutostart": autostart_supported(),
            "log": str(self.log_path),
        }

    def set_autostart(self, on: bool) -> bool:
        ok = set_autostart(on)
        if ok and self.icon is not None:
            self.icon.update_menu()
        return ok

    def open_log_folder(self) -> bool:
        try:
            os.startfile(str(self.log_path.parent))  # type: ignore[attr-defined]  # Windows only
            return True
        except (OSError, AttributeError):
            return False

    def show(self) -> None:
        if not self.windowed or self.window is None:
            open_app_window(self.url)
            return
        try:
            self.window.show()
            self.window.restore()
            # Windows doesn't let a background program take the focus; briefly keeping the
            # window on top brings it in front of everything anyway.
            self.window.on_top = True
            time.sleep(0.3)
            self.window.on_top = False
        except Exception as e:  # noqa: BLE001
            self.log(f"Couldn't show the window: {e}")

    def toggle_fullscreen(self) -> bool:
        if not self.windowed or self.window is None:
            return False
        try:
            self.window.toggle_fullscreen()
            return True
        except Exception:  # noqa: BLE001
            return False

    def pair_requested(self, req: dict) -> None:
        threading.Thread(target=self.show, daemon=True).start()
        self.notify(f"{req['deviceName']} wants to connect", f"Choose Allow in {APP_NAME}.")

    def notify(self, title: str, text: str) -> None:
        icon = self.icon
        if icon is not None and getattr(icon, "HAS_NOTIFICATION", False):
            try:
                icon.notify(text, title)
            except Exception:  # noqa: BLE001
                pass

    def quit(self) -> None:
        if self.quitting:
            return
        self.quitting = True
        self.hub.stop_soon()
        if self.icon is not None:
            try:
                self.icon.stop()
            except Exception:  # noqa: BLE001
                pass
        if self.window is not None and self.windowed:
            try:
                self.window.destroy()
            except Exception:  # noqa: BLE001
                pass

    # -------------------------------------------------- tray
    def _start_tray(self) -> None:
        try:
            import pystray
            from PIL import Image
        except ImportError:
            self.log("No tray icon (pystray isn't installed).")
            return
        try:
            image = Image.open(Path(__file__).resolve().parent.parent / "web" / "logo.png")
        except OSError:
            image = Image.new("RGB", (64, 64), "#ff2d95")
        items = [pystray.MenuItem(f"Open {APP_NAME}", lambda icon, item: self.show(), default=True)]
        if autostart_supported():
            items.append(pystray.MenuItem(
                "Start with Windows",
                lambda icon, item: self.set_autostart(not autostart_enabled()),
                checked=lambda item: autostart_enabled(),
            ))
        items += [pystray.Menu.SEPARATOR, pystray.MenuItem(f"Quit {APP_NAME}", lambda icon, item: self.quit())]
        self.icon = pystray.Icon(f"{brand.SCHEME}-hub", image, APP_NAME, pystray.Menu(*items))
        try:
            self.icon.run_detached()
        except Exception as e:  # noqa: BLE001
            self.log(f"No tray icon: {e}")
            self.icon = None

    # -------------------------------------------------- window
    def _on_initialized(self, renderer) -> bool:
        # Only Edge WebView2 renders the page properly; the old IE engine gets the fallback.
        return renderer == "edgechromium"

    def _on_shown(self) -> None:
        self.windowed = True
        try:
            hwnd = int(self.window.native.Handle.ToInt64())
        except Exception:  # noqa: BLE001
            return
        _dwm_attr(hwnd, 20, 1)  # dark title bar (Windows 10 and 11)
        _dwm_attr(hwnd, 35, _colorref(WINDOW_BG))  # title bar in the page's colour (Windows 11)
        _dwm_attr(hwnd, 36, _colorref(TITLE_TEXT))
        _dwm_attr(hwnd, 34, _colorref(WINDOW_BG))  # border

    def _on_closing(self) -> bool:
        if self.quitting:
            return True
        try:
            self.window.hide()
        except Exception:  # noqa: BLE001
            return True
        if self.icon is None:
            # No tray to come back from: closing the window quits.
            self.quitting = True
            self.hub.stop_soon()
            return True
        if not self.told_about_tray:
            self.told_about_tray = True
            self.notify(f"{APP_NAME} is still running", "Your devices can keep syncing. Right-click the icon in the tray to quit.")
        return False  # keep running in the tray

    def _run_window(self) -> bool:
        """Our own window; False when it can't be used (no pywebview or no WebView2)."""
        try:
            import webview
        except ImportError:
            return False
        try:
            self.window = webview.create_window(
                APP_NAME, self.url, width=1240, height=820, min_size=(860, 580),
                hidden=self.background, background_color=WINDOW_BG,
            )
            self.window.events.initialized += self._on_initialized
            self.window.events.shown += self._on_shown
            self.window.events.closing += self._on_closing
            storage = self.log_path.parent / "window"
            webview.start(private_mode=False, storage_path=str(storage))
        except Exception as e:  # noqa: BLE001
            self.log(f"Couldn't open the app window: {type(e).__name__}: {e}")
            return self.windowed
        return self.windowed

    def run(self) -> int:
        self._start_tray()
        # The hub's page has a Quit button (it stops the hub): close everything when that happens.
        threading.Thread(target=lambda: (self.hub._stop.wait(), self.quit()), daemon=True).start()
        if not self._run_window():
            self.log("Showing the hub in a browser window instead.")
            if not self.background:
                open_app_window(self.url)
            self.hub._stop.wait()
        self.quit()
        return 0
