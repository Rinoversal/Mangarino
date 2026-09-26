"""Wires the hub together: settings, library, pairing, transfers, panels and the server."""
from __future__ import annotations

import secrets
import threading
import time
import urllib.parse
from pathlib import Path

from . import BUILD, DEFAULT_PORT, VERSION, brand
from . import winutil
from .config import Config
from .files import FileGate
from .library import Library, volume_id
from .packer import Packer
from .progress import ProgressStore
from .pairing import Pairing
from .remote import RemoteLibraries, rel_of
from .panels import PanelWorker
from .server import HubServer
from .thumbs import Thumbs
from .transfers import Transfers

SCAN_EVERY_S = 30.0


class Hub:
    def __init__(self, config: Config, host: str = "0.0.0.0", log=print, panels: bool = True, cache: Path | None = None):
        self.config, self.log = config, log
        if config.problem:
            log(config.problem)
        self.admin_key = secrets.token_urlsafe(24)
        self.gate = FileGate()
        self.transfers = Transfers()
        self.library = Library(config.library_root)
        self.packer = Packer(cache)
        self.thumbs = Thumbs()
        self.remote = RemoteLibraries(self.packer.dir)  # what paired devices have
        self.progress = ProgressStore(Path(config.path).with_name("progress.json"))
        self.seen: dict[str, float] = {}  # device id -> last request time
        self._reached_now = False  # a device got through this run
        self.pairing = Pairing(config, on_request=self._pair_requested)
        self.desktop = None  # the window and tray icon, when running as the Windows app
        self.panels = PanelWorker(self.library, self.gate, self.transfers, config, log)
        self._panels_enabled = panels
        self.server = HubServer((host, config.port), self)  # raises OSError if the port is taken
        self.port = self.server.server_address[1]
        self._stop = threading.Event()
        self._firewall: dict = {}
        self._ips: list[str] = []
        self._tailscale: list[str] = []

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        default_root = Path.home() / brand.FOLDER
        if Path(self.config.library_root) == default_root and not default_root.exists():
            try:
                default_root.mkdir(parents=True)  # a ready place for manga, like the app's folder
            except OSError:
                pass
        self.library.scan()
        self._ips = winutil.lan_ips()
        self._tailscale = winutil.tailscale_ips()
        if self._panels_enabled:
            self.panels.start()
        else:
            self.panels.state, self.panels.reason = "off", "Panel detection is off for this run (--no-panels)."
        threading.Thread(target=self._housekeeping, name="housekeeping", daemon=True).start()
        if not self.reached_from_network:  # devices got through lately: no need to ask Windows
            threading.Thread(target=lambda: self._firewall.update(winutil.firewall_check(self.port)), daemon=True).start()
        threading.Thread(target=self.server.serve_forever, name="http", daemon=True).start()

    def wait(self) -> None:
        try:
            while not self._stop.wait(0.5):
                pass
        except KeyboardInterrupt:
            pass
        self.shutdown()

    def stop_soon(self) -> None:
        self._stop.set()

    def shutdown(self) -> None:
        self._stop.set()
        self.panels.stop()
        self.server.shutdown()
        self.server.server_close()
        winutil.set_keep_awake(False)
        self.log(f"{brand.HUB} stopped.")

    def _housekeeping(self) -> None:
        """Rescans the folder, refreshes the network addresses and keeps the PC awake while a
        device is transferring or panels are being made. One thread, so keep-awake sticks."""
        last_scan = 0.0
        awake = False
        while not self._stop.wait(2.0):
            now = time.time()
            if now - last_scan >= SCAN_EVERY_S:
                last_scan = now
                try:
                    if self.library.scan():
                        self.panels.poke()
                    self._ips = winutil.lan_ips() or self._ips
                    self._tailscale = winutil.tailscale_ips()
                except Exception as e:  # noqa: BLE001 - one bad file or glitch must not stop housekeeping
                    self.log(f"Library scan failed: {type(e).__name__}: {e}")
            busy = self.transfers.any_active() or self.panels.state == "working"
            if busy != awake:
                awake = busy
                winutil.set_keep_awake(busy)

    # ------------------------------------------------------------------ actions
    def _pair_requested(self, req: dict) -> None:
        self.log(f"{req['deviceName']} wants to connect. Allow it in the {brand.HUB} window.")
        if self.desktop is not None:
            self.desktop.pair_requested(req)

    def after_upload(self) -> None:
        threading.Thread(target=lambda: (self.library.scan(), self.panels.poke()), daemon=True).start()

    @property
    def reached_from_network(self) -> bool:
        """A device got through lately (this run, or within 30 days): the firewall is fine."""
        return self._reached_now or time.time() * 1000 - self.config.reached_ms < 30 * 86400 * 1000

    def note_reached(self) -> None:
        self._reached_now = True
        now = int(time.time() * 1000)
        if now - self.config.reached_ms > 3600 * 1000:  # remembered, at most once an hour
            self.config.update(reached_ms=now)

    def set_away(self, on: bool) -> None:
        self.config.update(away=bool(on))

    def forget_device(self, device_id: str) -> None:
        self.pairing.forget(device_id)
        self.remote.forget(device_id)

    # ------------------------------------------------------------------ devices' libraries
    def remote_overview(self) -> list[dict]:
        """Each paired device's library as it last reported it, and whether it's reachable."""
        names = {d["id"]: d.get("name", "") for d in self.config.devices}
        kinds = {d["id"]: d.get("kind", "") for d in self.config.devices}
        out = []
        for c in self.remote.overview():
            dev = c["deviceId"]
            if dev in names:
                out.append({**c, "name": names[dev], "kind": kinds[dev], "online": time.time() - self.seen.get(dev, 0) < 20})
        return out

    def remote_status(self, device_id: str, vid: int) -> dict:
        """Where a device's volume is: "ready" on this PC, "sending", "waiting" for the device
        to pick up the request (it isn't open), or "starting"."""
        vol = self.remote.volume(device_id, vid)
        if vol is None:
            return {"state": "gone"}
        rel = rel_of(vol)
        local = self.library.get(volume_id(rel))
        if local is not None:
            self.remote.done_asking(device_id, vid)
            return {"state": "ready", "volumeId": local.id}
        for t in self.transfers.snapshot()["active"]:
            if t["kind"] == "to PC" and t["name"].lower() == rel.lower():
                return {"state": "sending", "bytes": t["bytes"], "total": t["total"]}
        listening = self.remote.is_listening(device_id)
        if self.remote.waiting_for_pickup(device_id, vid):
            return {"state": "waiting", "listening": listening}
        if listening and self.remote.reask_if_lost(device_id, vid):
            return {"state": "waiting", "listening": listening}  # the last request seems lost: asked again
        return {"state": "starting", "listening": listening}

    def remote_want(self, device_id: str, vid: int) -> dict:
        """This PC wants to read a volume that is only on a device: ask the device to send it."""
        st = self.remote_status(device_id, vid)
        if st["state"] in ("ready", "sending", "gone"):
            return st
        self.remote.ask_to_send(device_id, vid)
        return self.remote_status(device_id, vid)

    def set_root(self, root: str) -> None:
        self.config.update(library_root=root)
        self.library.set_root(root)
        self.panels.poke()
        self.log(f"Library folder: {root}")

    def choose_folder(self, title: str = "Choose your manga folder") -> str:
        return winutil.choose_folder(str(self.library.root), title)

    def firewall_check(self) -> dict:
        self._firewall = winutil.firewall_check(self.port)
        return self._firewall

    def firewall_fix(self) -> dict:
        res = winutil.firewall_fix(self.port)
        self._firewall = {k: v for k, v in res.items() if k != "ok"}
        return res

    # ------------------------------------------------------------------ status
    def pair_url(self, ip: str | None = None) -> str:
        away = self._tailscale if self.config.away else []  # the Tailscale address only when "Away from home" is on
        ip = ip if ip in self._ips else (self._ips[0] if self._ips else (away[0] if away else "127.0.0.1"))
        # As short as possible: fewer characters make a coarser QR code that tablet cameras
        # read easily. The app learns the PC's name and id from the hub once paired.
        params = {"h": ip, "c": self.pairing.current_code()}
        if self.port != DEFAULT_PORT:
            params["p"] = self.port
        if away:
            params["t"] = away[0]  # lets the device reach this PC away from home
        q = urllib.parse.urlencode(params)
        return f"{brand.SCHEME}://pc?{q}"

    def qr_svg(self, ip: str | None = None, scale: int = 8) -> bytes:
        try:
            import segno
        except ImportError:
            return b'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="10" y="35" font-size="14">Install segno for the QR code</text></svg>'
        qr = segno.make(self.pair_url(ip), error="m")
        # Pure black on white with the standard 4-module quiet zone: what scanners handle best.
        # omitsize: a viewBox instead of a fixed width and height, so the page can size it.
        return qr.svg_inline(scale=max(2, min(40, scale)), border=4, dark="#000000", light="#ffffff", omitsize=True).encode("utf-8")

    def status(self) -> dict:
        return {
            "version": VERSION,
            "build": BUILD,
            "brand": brand.NAME,
            "name": self.config.name,
            "port": self.port,
            "addresses": self._ips,
            "tailscale": self._tailscale,
            "code": self.pairing.current_code(),
            "pairRequests": self.pairing.pending(),
            "pairUrl": self.pair_url(),
            "library": self.library.summary(),
            "panels": self.panels.status(),
            "transfers": self.transfers.snapshot(),
            "devices": [
                {
                    "id": d["id"],
                    "name": d.get("name", ""),
                    "kind": d.get("kind", ""),
                    "pairedMs": d.get("paired_ms"),
                    "lastSeenMs": int(self.seen[d["id"]] * 1000) if d["id"] in self.seen else None,
                    "online": time.time() - self.seen.get(d["id"], 0) < 20,
                }
                for d in self.config.devices
            ],
            "reachedFromNetwork": self.reached_from_network,
            "away": self.config.away,
            "firewall": self._firewall,
            "desktop": self.desktop.info() if self.desktop is not None else None,
        }

    def root_path(self) -> Path:
        return self.library.root
