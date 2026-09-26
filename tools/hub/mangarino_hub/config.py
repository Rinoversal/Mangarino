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


class Config:
    """Everything the hub remembers between runs. Paired devices keep only a hash of their
    token, never the token itself."""

    def __init__(self, path: Path | None = None):
        self.path = path or app_dir() / "hub.json"
        self.lock = threading.RLock()
        data: dict = {}
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
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
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(self.to_dict(), indent=1), encoding="utf-8")
            os.replace(tmp, self.path)

    def update(self, **changes) -> None:
        with self.lock:
            for k, v in changes.items():
                setattr(self, k, v)
            self.save()
