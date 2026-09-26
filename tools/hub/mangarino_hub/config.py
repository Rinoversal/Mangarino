"""Hub settings, kept in %APPDATA%\\Mangarino\\hub.json (the test build: Testarino) and written atomically."""
from __future__ import annotations

import json
import os
import secrets
import socket
import threading
from pathlib import Path

from . import DEFAULT_PORT, brand


def app_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / brand.FOLDER
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read(path: Path) -> dict | None:
    """The settings in `path`, or None when it's missing or not a readable settings object."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


class Config:
    """Everything the hub remembers between runs. Paired devices keep only a hash of their
    token, never the token itself."""

    def __init__(self, path: Path | None = None):
        self.path = path or app_dir() / "hub.json"
        self.backup = self.path.with_name(self.path.name + ".bak")  # the last good copy
        self.lock = threading.RLock()
        self.problem = ""  # what went wrong reading the settings, for the log
        data = _read(self.path)
        if data is None and self.path.exists():
            # Damaged (a crash mid-write, a disk error, a hand edit): set it aside and carry on from
            # the last good copy, rather than silently forgetting every paired device.
            try:
                os.replace(self.path, self.path.with_name(self.path.name + ".bad"))
            except OSError:
                pass
            data = _read(self.backup)
            self.problem = (
                "The settings file was damaged; carried on from its last good copy (kept as hub.json.bad)."
                if data is not None
                else "The settings file was damaged and had no good copy; started afresh (kept as hub.json.bad)."
            )
        data = data or {}
        self.server_id: str = data.get("server_id") or secrets.token_hex(8)
        self.name: str = data.get("name") or os.environ.get("COMPUTERNAME") or socket.gethostname() or "PC"
        self.library_root: str = data.get("library_root") or str(Path.home() / brand.FOLDER)
        self.port: int = int(data.get("port") or DEFAULT_PORT)
        self.panels: str = data.get("panels") or "auto"  # auto | on | off
        self.panelizer_dir: str = data.get("panelizer_dir") or ""  # for the .exe: where panelize.py lives
        self.devices: list[dict] = list(data.get("devices") or [])
        self.reached_ms: int = int(data.get("reached_ms") or 0)  # last time a device got through the network
        self.away: bool = bool(data.get("away"))  # "Away from home" (Tailscale) switched on
        self.save()

    def to_dict(self) -> dict:
        return {
            "server_id": self.server_id,
            "name": self.name,
            "library_root": self.library_root,
            "port": self.port,
            "panels": self.panels,
            "panelizer_dir": self.panelizer_dir,
            "devices": self.devices,
            "reached_ms": self.reached_ms,
            "away": self.away,
        }

    def save(self) -> None:
        with self.lock:
            text = json.dumps(self.to_dict(), indent=1)
            for target in (self.path, self.backup):  # one at a time, so one of them is always whole
                tmp = target.with_name(target.name + ".tmp")
                tmp.write_text(text, encoding="utf-8")
                os.replace(tmp, target)

    def update(self, **changes) -> None:
        with self.lock:
            for k, v in changes.items():
                setattr(self, k, v)
            self.save()
