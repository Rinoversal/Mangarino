"""Windows helpers: network addresses, keep-awake, the folder picker and the firewall."""
from __future__ import annotations

import base64
import ipaddress
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

from . import brand

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
RULE_NAME = brand.HUB
TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")
TAILSCALE_DNS = "100.100.100.100"  # Tailscale's own resolver: routed through Tailscale when it's on


def lan_ips() -> list[str]:
    """This PC's private IPv4 addresses, the one used for the default route first."""
    ips: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the route
            ips.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError:
        pass
    out: list[str] = []
    for ip in ips:
        a = ipaddress.ip_address(ip)
        if a.is_private and not a.is_loopback and not a.is_link_local and ip not in out:
            out.append(ip)
    return out


def tailscale_ips() -> list[str]:
    """This PC's Tailscale addresses (empty when Tailscale isn't running). Devices signed in to
    the same Tailscale account reach the hub at these from anywhere."""
    ips: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((TAILSCALE_DNS, 53))  # no packet is sent; the OS picks the Tailscale route
            ips.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError:
        pass
    try:
        import psutil  # present with the panelizer's packages; optional

        for addrs in psutil.net_if_addrs().values():
            ips.extend(a.address for a in addrs if a.family == socket.AF_INET)
    except Exception:  # noqa: BLE001
        pass
    out: list[str] = []
    for ip in ips:
        try:
            if ipaddress.ip_address(ip) in TAILSCALE_NET and ip not in out:
                out.append(ip)
        except ValueError:
            pass
    return out


def set_keep_awake(on: bool) -> None:
    """Stop the PC sleeping while it's busy. Must be called from one long-lived thread."""
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))
    except (OSError, AttributeError):
        pass


_PICKER = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '__TITLE__'
$d.ShowNewFolderButton = $true
$start = '__START__'
if ($start -and (Test-Path -LiteralPath $start)) { $d.SelectedPath = $start }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
"""


def choose_folder(initial: str = "", title: str = "Choose your manga folder") -> str:
    """Windows' folder picker (works from the .exe too); '' when cancelled."""
    if os.name != "nt":
        return ""
    script = _PICKER.replace("__TITLE__", title.replace("'", "''")).replace("__START__", initial.replace("'", "''"))
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-EncodedCommand", enc],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
            creationflags=CREATE_NO_WINDOW,
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def python_programs() -> list[str]:
    """The executables Windows Firewall sees for this hub. A venv's python.exe re-launches the
    base interpreter, so both are listed."""
    progs = [sys.executable, getattr(sys, "_base_executable", sys.executable)]
    return list(dict.fromkeys(os.path.normcase(os.path.abspath(p)) for p in progs))


def _ps(script: str, timeout: float = 60) -> str:
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
        capture_output=True, text=True, timeout=timeout, creationflags=CREATE_NO_WINDOW,
    )
    return out.stdout.strip()


def _ps_list(items: list[str]) -> str:
    return ",".join("'" + i.replace("'", "''") + "'" for i in items)


def firewall_check(port: int) -> dict:
    """{"allowRule": bool, "blocked": n, "profiles": [...]} or {"error": ...}; no admin needed."""
    if os.name != "nt":
        return {"allowRule": True, "blocked": 0, "profiles": []}
    script = f"""
$ErrorActionPreference = 'SilentlyContinue'
$allow = @(Get-NetFirewallRule -DisplayName '{RULE_NAME}*' -Direction Inbound -Enabled True -Action Allow).Count
$blocked = 0
foreach ($p in @({_ps_list(python_programs())})) {{
  $blocked += @(Get-NetFirewallApplicationFilter -Program $p | Get-NetFirewallRule |
    Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }}).Count
}}
$profiles = @(Get-NetConnectionProfile | ForEach-Object {{ [string]$_.NetworkCategory }})
@{{ allowRule = ($allow -gt 0); blocked = $blocked; profiles = $profiles; port = {int(port)} }} | ConvertTo-Json -Compress
"""
    try:
        return json.loads(_ps(script) or "{}")
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        return {"error": f"{type(e).__name__}: {e}"}


FROZEN = bool(getattr(sys, "frozen", False))


def allow_devices(port: int) -> bool:
    """Run with administrator rights (hub.py --allow-devices, started by firewall_fix, or the
    installer does the same): let devices on the local network and Tailscale reach the hub, and
    remove Windows' Block rules for it (made when its first firewall question was dismissed)."""
    if os.name != "nt":
        return True
    run = lambda *args: subprocess.run(["netsh", "advfirewall", "firewall", *args], capture_output=True,  # noqa: E731
                                       creationflags=CREATE_NO_WINDOW, timeout=60)
    run("delete", "rule", f"name={RULE_NAME}")
    target = [f"program={sys.executable}"] if FROZEN else ["protocol=TCP", f"localport={int(port)}"]
    added = run("add", "rule", f"name={RULE_NAME}", "dir=in", "action=allow", *target, "enable=yes",
                "profile=any", "remoteip=localsubnet,100.64.0.0/10").returncode == 0
    script = f"""
foreach ($p in @({_ps_list(python_programs())})) {{
  Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule |
    Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }} | Remove-NetFirewallRule
}}
"""
    try:
        _ps(script, timeout=120)
    except (OSError, subprocess.SubprocessError):
        pass
    return added


def _run_as_admin(exe: str, params: str, timeout_s: float = 300) -> int | None:
    """Start a program with administrator rights (Windows asks first) and wait for it.
    Its exit code, or None when the question was declined or it couldn't start."""
    import ctypes
    from ctypes import wintypes

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD), ("fMask", ctypes.c_ulong), ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR), ("hkeyClass", wintypes.HKEY),
            ("dwHotKey", wintypes.DWORD), ("hIconOrMonitor", wintypes.HANDLE), ("hProcess", wintypes.HANDLE),
        ]

    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x00000040 | 0x00008000  # SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NO_CONSOLE
    info.lpVerb = "runas"
    info.lpFile = exe
    info.lpParameters = params
    info.nShow = 0  # SW_HIDE
    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info)) or not info.hProcess:
        return None  # declined (ERROR_CANCELLED) or failed
    try:
        ctypes.windll.kernel32.WaitForSingleObject(info.hProcess, int(timeout_s * 1000))
        code = wintypes.DWORD()
        ctypes.windll.kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
        return int(code.value)
    finally:
        ctypes.windll.kernel32.CloseHandle(info.hProcess)


def firewall_fix(port: int) -> dict:
    """Ask Windows once ("allow Mangarino Hub to make changes?") and let devices through: the hub
    runs itself with administrator rights for a moment (allow_devices). No console window."""
    if os.name != "nt":
        return {"ok": True}
    if FROZEN:
        code = _run_as_admin(sys.executable, f"--allow-devices --port {int(port)}")
    else:
        hub = Path(__file__).resolve().parent.parent / "hub.py"
        code = _run_as_admin(sys.executable, f'"{hub}" --allow-devices --port {int(port)}')
    if code is None:
        return {"ok": False, "cancelled": True, **firewall_check(port)}
    return {"ok": code == 0, **firewall_check(port)}
