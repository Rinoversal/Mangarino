"""Background panel detection for the PC's library, using tools/panelizer/panelize.py.

One volume at a time, oldest problem first:
- volumes with no panels are done automatically (mode "auto" needs an NVIDIA GPU, "on" also
  runs on the CPU, "off" never runs);
- volumes with old-style panels (no speech-bubble growth) are redone automatically too.
It waits while a device is transferring, so the disk and the network stay fast. Detection only
reads a volume (devices can keep downloading it meanwhile); the finished panels are swapped in
through the FileGate, which waits for downloads of that file, so none sees a half-written file.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import zipfile
from pathlib import Path

from .library import JSON_ENTRY

PANELIZER_DIR = Path(__file__).resolve().parents[2] / "panelizer"
RELOAD_AFTER_FAIL_S = 300
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
FROZEN = bool(getattr(sys, "frozen", False))  # running as Mangarino Hub.exe


def panelizer_python(folder: Path) -> Path | None:
    """The panelizer's own Python (its .venv), which has the detection packages."""
    for cand in (folder / ".venv" / "Scripts" / "python.exe", folder / ".venv" / "bin" / "python"):
        if cand.is_file():
            return cand
    return None


def file_version(path: Path) -> str:
    st = os.stat(path)
    return f"{st.st_size}-{st.st_mtime_ns}"


def add_panels_entry(path: Path, payload: bytes, expect: str, replace) -> bool:
    """Write a copy of the zip at `path` with the panels entry added (or replaced), then swap it
    in with `replace` (the gate's, which waits for downloads of `path` to finish). False, changing
    nothing, when the file isn't the `expect` version any more."""
    fd, name = tempfile.mkstemp(prefix=".panels-", suffix=".tmp", dir=str(path.parent))
    os.close(fd)
    tmp = Path(name)
    try:
        with zipfile.ZipFile(path) as zin:
            st = os.fstat(zin.fp.fileno())
            if f"{st.st_size}-{st.st_mtime_ns}" != expect:
                return False
            with zipfile.ZipFile(tmp, "w", allowZip64=True) as zout:
                zout.comment = zin.comment
                for info in zin.infolist():
                    if info.filename == JSON_ENTRY:
                        continue
                    if info.is_dir():
                        zout.writestr(info, b"")
                        continue
                    with zin.open(info) as src, zout.open(info, "w") as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)
                entry = zipfile.ZipInfo(JSON_ENTRY, date_time=time.localtime()[:6])
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o644 << 16
                zout.writestr(entry, payload)
        replace(tmp, path)
        return True
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def valid_panelizer(folder: Path) -> bool:
    return (folder / "panelize.py").is_file() and panelizer_python(folder) is not None


RECENT_S = 3600  # arrived within the hour: panelize before older volumes

class PanelWorker:
    def __init__(self, library, gate, transfers, config, log=print):
        self.library, self.gate, self.transfers, self.config, self.log = library, gate, transfers, config, log
        self.state = "starting"  # starting | off | unavailable | loading | idle | paused | working
        self.reason = ""
        self.device = ""
        self.current: dict | None = None
        self.failed: dict[str, str] = {}  # volume id -> version that failed
        self.upgrade = False
        self.done = 0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._pz = self._det = self._bub = None
        self._ext: tuple[Path, Path] | None = None  # (python, panelize.py) when run as a separate program
        self.needs_panelizer = False
        self._load_failed_at = 0.0
        self._thread = threading.Thread(target=self._run, name="panels", daemon=True)

    # ------------------------------------------------------------------ control
    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def poke(self, reload: bool = False) -> None:
        if reload:
            self._load_failed_at = 0.0
        self._wake.set()

    def use_panelizer(self, folder: str) -> bool:
        """Point the hub (the .exe especially) at a panelizer folder; True if it looks right."""
        if not valid_panelizer(Path(folder)):
            return False
        self.config.update(panelizer_dir=folder)
        self._pz = self._det = self._bub = None
        self._ext = None
        self.needs_panelizer = False
        self.poke(reload=True)
        return True

    def request_upgrade(self) -> None:
        self.upgrade = True
        self.poke()

    def retry_failed(self) -> None:
        for vid in list(self.failed):
            v = self.library.get(vid)
            if v:
                self.library.set_overlay(vid, v.version, None)
        self.failed.clear()
        self.poke(reload=True)

    # ------------------------------------------------------------------ status
    def todo(self) -> list:
        """Volumes without panels, and volumes panelized before the speech-bubble fix (a device
        sends those; the fix is the point). Newly arrived ones first, so a volume a device just
        sent is ready soon."""
        now = time.time()
        with self.library.lock:
            vols = [v for v in self.library.volumes.values() if v.panels in ("none", "old") and self.failed.get(v.id) != v.version]
        vols.sort(key=lambda v: (now - v.mtime_ns / 1e9 > RECENT_S, v.panels != "none", v.rel.lower()))
        return vols

    def brief(self) -> dict:
        return {"state": self.state, "device": self.device, "queued": len(self.todo())}

    def status(self) -> dict:
        with self.library.lock:
            old = sum(1 for v in self.library.volumes.values() if v.panels == "old")
        return {
            "state": self.state, "reason": self.reason, "device": self.device, "mode": self.config.panels,
            "current": self.current, "queued": len(self.todo()), "done": self.done,
            "failed": len(self.failed), "old": old, "upgrading": self.upgrade,
            "needsPanelizer": self.needs_panelizer, "panelizerDir": self.config.panelizer_dir,
        }

    # ------------------------------------------------------------------ work
    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(5.0)
            self._wake.clear()
            if self._stop.is_set():
                break
            try:
                self._step()
            except Exception as e:  # noqa: BLE001
                self.log(f"Panel worker error: {type(e).__name__}: {e}")
                traceback.print_exc()
                time.sleep(5)

    def _step(self) -> None:
        if self.config.panels == "off":
            self.state, self.reason, self.current = "off", "Panel detection is turned off.", None
            return
        todo = self.todo()
        if not todo:
            self.upgrade, self.current = False, None
            if self.state not in ("off", "unavailable"):
                self.state, self.reason = "idle", ""
            return
        if self.transfers.any_active():
            self.state, self.reason = "paused", "Waiting for transfers to finish."
            return
        if not self._load():
            return
        v = todo[0]
        self.state, self.reason = "working", ""
        if self._ext is not None:
            self._process_external(v)
        else:
            self._process(v)
        self._wake.set()  # straight on to the next one

    def _load(self) -> bool:
        if self._pz is not None or self._ext is not None:
            return True
        if self._load_failed_at and time.time() - self._load_failed_at < RELOAD_AFTER_FAIL_S:
            return False
        self.state, self.reason = "loading", "Loading the detection models..."
        if FROZEN or self.config.panelizer_dir:
            return self._load_external()
        try:
            if str(PANELIZER_DIR) not in sys.path:
                sys.path.insert(0, str(PANELIZER_DIR))
            import panelize as pz
            import torch

            gpu = torch.cuda.is_available()
            if self.config.panels == "auto" and not gpu:
                self.state = "off"
                self.reason = "No NVIDIA graphics card found. Switch panels to On to use the CPU (slow)."
                self._load_failed_at = time.time()
                return False
            pz.log = lambda msg="": self.log(f"[panels] {msg}") if msg else None
            det = pz.Detector("auto" if gpu else "cpu", 0.25, 640, 16)
            try:
                bub = pz.BubbleDetector(det.device)
            except Exception as e:  # noqa: BLE001
                self.log(f"Speech-bubble model unavailable ({type(e).__name__}: {e}); panels will grow over lettering only.")
                bub = None
            self._pz, self._det, self._bub = pz, det, bub
            self.device = torch.cuda.get_device_name(0) if det.cuda else "CPU"
            self.log(f"Panel detection ready on {self.device}.")
            return True
        except ImportError:
            return self._load_external()  # this Python lacks torch: try a panelizer folder instead
        except Exception as e:  # noqa: BLE001
            self.state = "unavailable"
            self.reason = f"Panel tools not installed ({type(e).__name__}: {e})."
            self._load_failed_at = time.time()
            return False

    def _load_external(self) -> bool:
        """Use a panelizer folder's own Python as a separate program (how the .exe does panels)."""
        folder = Path(self.config.panelizer_dir) if self.config.panelizer_dir else PANELIZER_DIR
        py = panelizer_python(folder)
        if not (folder / "panelize.py").is_file() or py is None:
            self.state = "unavailable"
            self.needs_panelizer = True
            self.reason = "Panel detection needs the panelizer set up on this PC. Choose its folder (tools\\panelizer) below."
            self._load_failed_at = time.time()
            return False
        try:
            out = subprocess.run(
                [str(py), "-c", "import torch; g = torch.cuda.is_available(); print(g, torch.cuda.get_device_name(0) if g else 'CPU')"],
                capture_output=True, text=True, timeout=180, creationflags=CREATE_NO_WINDOW,
            )
            gpu_line = (out.stdout.strip().splitlines() or ["False CPU"])[-1]
        except (OSError, subprocess.SubprocessError) as e:
            self.state, self.reason = "unavailable", f"The panelizer's Python didn't start ({type(e).__name__})."
            self._load_failed_at = time.time()
            return False
        gpu = gpu_line.startswith("True")
        if self.config.panels == "auto" and not gpu:
            self.state = "off"
            self.reason = "No NVIDIA graphics card found. Switch panels to On to use the CPU (slow)."
            self._load_failed_at = time.time()
            return False
        self._ext = (py, folder / "panelize.py")
        self.needs_panelizer = False
        self.device = (gpu_line.split(" ", 1)[1] if gpu else "CPU") + " (panelizer)"
        self.log(f"Panel detection ready: {self.device}.")
        return True

    def _process_external(self, v) -> None:
        py, script = self._ext
        self.library.set_overlay(v.id, v.version, "working")
        self.current = {"name": v.rel, "done": 0, "total": 0}
        t0 = time.time()
        tail: list[str] = []
        out_dir = Path(tempfile.mkdtemp(prefix="panels-"))
        try:
            before = file_version(v.path) if v.kind != "folder" else ""
            # The panelizer only reads the volume and writes the panels into out_dir; _store
            # puts them in the volume afterwards.
            proc = subprocess.Popen(
                [str(py), str(script), str(v.path), "--overwrite", "--dry-run", "--json-out", str(out_dir), "--progress"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                creationflags=CREATE_NO_WINDOW,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                if line.startswith("PROGRESS "):
                    try:
                        done, total = (int(x) for x in line.split()[1:3])
                        if self.current:
                            self.current.update(done=done, total=total)
                    except ValueError:
                        pass
                elif line.strip():
                    tail = (tail + [line.strip()])[-5:]
            code = proc.wait(timeout=3600)
            if code != 0:
                raise RuntimeError(tail[-1] if tail else f"panelizer exited with {code}")
            found = sorted(out_dir.glob("*.panels.json"))
            if not found:
                note = next((t for t in reversed(tail) if t.startswith(("skip", "ERROR"))), "")
                raise RuntimeError(note or "the panelizer wrote no panels")
            if not self._store(v, found[0].read_text(encoding="utf-8"), before):
                self.library.set_overlay(v.id, v.version, None)
                return  # the file changed while we worked; the next scan offers the new one
            self.done += 1
            self.library.set_overlay(v.id, v.version, None)
            self.library.mark_complete(v.rel)
            self.log(f"Panels ready: {v.rel} ({time.time() - t0:.0f} s).")
        except Exception as e:  # noqa: BLE001
            self.failed[v.id] = v.version
            self.library.set_overlay(v.id, v.version, "failed")
            self.log(f"Panels failed for {v.rel}: {type(e).__name__}: {e}")
        finally:
            self.current = None
            shutil.rmtree(out_dir, ignore_errors=True)
            self.library.scan()

    def _store(self, v, text: str, before: str) -> bool:
        """Put the panels into the volume. False, leaving it alone, when the file changed since
        `before` (a device sent a new copy meanwhile)."""
        if v.kind == "folder":
            # Folder volumes keep their panels next to the images, like the command-line tool.
            target = v.path / JSON_ENTRY
            tmp = target.with_name(target.name + ".tmp")
            tmp.write_text(text, encoding="utf-8")
            self.gate.replace(tmp, target)
            return True
        return add_panels_entry(v.path, text.encode("utf-8"), before, self.gate.replace)

    def _process(self, v) -> None:
        pz = self._pz
        self.library.set_overlay(v.id, v.version, "working")
        self.current = {"name": v.rel, "done": 0, "total": 0}
        t0 = time.time()
        try:
            before = file_version(v.path) if v.kind != "folder" else ""
            src = pz.PageSource(v.path)
            try:
                if not src.names:
                    raise ValueError("no image pages")
                self.current["total"] = len(src.names)
                pages = pz.detect_pages(
                    src, self._det, rtl=True, bub=self._bub,
                    on_progress=lambda done, total: self.current and self.current.update(done=done, total=total),
                )
            finally:
                src.close()
            text = pz.build_json(pages, 0.25, rtl=True, bubbles=pz.BUBBLE_REPO if self._bub else None)
            if not self._store(v, text, before):
                self.library.set_overlay(v.id, v.version, None)
                return  # the file changed while we worked; the next scan offers the new one
            self.library.mark_complete(v.rel)  # we wrote it: offer it now, not after the copy window
            self.done += 1
            self.library.set_overlay(v.id, v.version, None)
            self.log(f"Panels ready: {v.rel} ({len(pages)} pages, {time.time() - t0:.0f} s).")
        except Exception as e:  # noqa: BLE001
            self.failed[v.id] = v.version
            self.library.set_overlay(v.id, v.version, "failed")
            self.log(f"Panels failed for {v.rel}: {type(e).__name__}: {e}")
        finally:
            self.current = None
            self.library.scan()
