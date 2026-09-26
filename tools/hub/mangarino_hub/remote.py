"""What paired devices have, so this PC can show their libraries and read from them.

A device that is open and connected posts its catalog (series, volumes, where it's up to) and
its cover images, and keeps a request open (GET /api/requests) through which this PC asks it to
send a volume. The volume then arrives as an ordinary upload into the PC's library, and opens.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path

from .thumbs import shrink

MAX_SERIES = 5000
MAX_VOLUMES = 50000
MAX_TEXT = 300
MAX_WAIT_S = 25
ONLINE_S = 40  # a device that asked for requests this recently is listening


def _text(v, limit: int = MAX_TEXT) -> str:
    return str(v if v is not None else "")[:limit]


def _int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def clean_catalog(raw) -> list[dict]:
    """The device's catalog, checked and trimmed: [{id, title, volumes: [{id, file, folder,
    key, size, pages, kind, cover}]}]."""
    out: list[dict] = []
    total = 0
    for s in (raw or [])[:MAX_SERIES] if isinstance(raw, list) else []:
        if not isinstance(s, dict):
            continue
        vols = []
        for v in s.get("volumes") or []:
            if not isinstance(v, dict) or total >= MAX_VOLUMES:
                continue
            file = _text(v.get("file"))
            if not file:
                continue
            total += 1
            vols.append({
                "id": _int(v.get("id")),
                "file": file,
                "folder": _text(v.get("folder")),  # where it lands on this PC when sent
                "key": _text(v.get("key")),  # its reading-progress key
                "size": max(0, _int(v.get("size"))),
                "pages": max(0, _int(v.get("pages"))),
                "kind": "dir" if v.get("kind") == "dir" else "cbz",
                "cover": _text(v.get("cover"), 80),  # changes when the cover image changes
            })
        if vols:
            out.append({"id": _int(s.get("id")), "title": _text(s.get("title")) or "Untitled", "volumes": vols})
    return out


class RemoteLibraries:
    def __init__(self, cache_dir: Path):
        self.covers_dir = Path(cache_dir) / "device-covers"
        self.catalogs_dir = Path(cache_dir) / "device-catalogs"
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.catalogs: dict[str, dict] = {}  # device id -> {"series": [...], "updatedMs": ...}
        self.pending: dict[str, list[dict]] = {}  # device id -> requests not yet picked up
        self.asked: dict[tuple[str, int], float] = {}  # (device, volume) -> when this PC asked
        self.listening: dict[str, float] = {}  # device id -> last time it waited for requests
        self._load()

    # ------------------------------------------------------------------ kept between runs
    def _catalog_file(self, device_id: str) -> Path:
        return self.catalogs_dir / (hashlib.sha1(device_id.encode("utf-8")).hexdigest()[:20] + ".json")

    def _load(self) -> None:
        """Devices' last catalogs, so this PC shows their libraries even while they're off."""
        for f in self.catalogs_dir.glob("*.json") if self.catalogs_dir.is_dir() else []:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                self.catalogs[str(data["deviceId"])] = {"series": clean_catalog(data["series"]), "updatedMs": int(data["updatedMs"])}
            except (OSError, ValueError, KeyError, TypeError):
                continue

    def _save(self, device_id: str, cat: dict) -> None:
        try:
            self.catalogs_dir.mkdir(parents=True, exist_ok=True)
            path = self._catalog_file(device_id)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps({"deviceId": device_id, **cat}, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            pass

    # ------------------------------------------------------------------ from devices
    def set_catalog(self, device_id: str, raw) -> list[int]:
        """Store a device's catalog. Returns the volume ids whose covers this PC lacks, the
        first volume of each series first (those show in the series grid)."""
        series = clean_catalog(raw)
        cat = {"series": series, "updatedMs": int(time.time() * 1000)}
        with self.lock:
            changed = self.catalogs.get(device_id, {}).get("series") != series
            self.catalogs[device_id] = cat
        if changed:
            self._save(device_id, cat)
        firsts = [s["volumes"][0] for s in series]
        rest = [v for s in series for v in s["volumes"][1:]]
        return [v["id"] for v in firsts + rest if not self._cover_file(device_id, v["id"], v["cover"]).is_file()]

    def _cover_file(self, device_id: str, volume_id: int, version: str) -> Path:
        tag = hashlib.sha1(f"{device_id}/{volume_id}/{version}".encode("utf-8")).hexdigest()[:20]
        return self.covers_dir / f"{tag}.jpg"

    def save_cover(self, device_id: str, volume_id: int, raw: bytes) -> bool:
        vol = self.volume(device_id, volume_id)
        if vol is None:
            return False
        small = shrink(raw)
        body = small[0] if small else raw
        path = self._cover_file(device_id, volume_id, vol["cover"])
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(path)
        return True

    def cover(self, device_id: str, volume_id: int) -> bytes | None:
        vol = self.volume(device_id, volume_id)
        if vol is None:
            return None
        path = self._cover_file(device_id, volume_id, vol["cover"])
        try:
            return path.read_bytes()
        except OSError:
            return None

    def take_requests(self, device_id: str, wait: float) -> list[dict]:
        """A device waiting for this PC's requests (long poll, up to 25 s)."""
        deadline = time.time() + max(0.0, min(float(wait), MAX_WAIT_S))
        with self.lock:
            self.listening[device_id] = time.time()
            while not self.pending.get(device_id):
                left = deadline - time.time()
                if left <= 0:
                    return []
                self.changed.wait(min(left, 1.0))
                self.listening[device_id] = time.time()
            return self.pending.pop(device_id)

    # ------------------------------------------------------------------ for this PC
    def volume(self, device_id: str, volume_id: int) -> dict | None:
        with self.lock:
            cat = self.catalogs.get(device_id)
            if not cat:
                return None
            for s in cat["series"]:
                for v in s["volumes"]:
                    if v["id"] == volume_id:
                        return v
        return None

    def is_listening(self, device_id: str) -> bool:
        return time.time() - self.listening.get(device_id, 0) < ONLINE_S

    def overview(self) -> list[dict]:
        with self.lock:
            return [
                {"deviceId": d, "updatedMs": c["updatedMs"], "series": c["series"], "listening": self.is_listening(d)}
                for d, c in self.catalogs.items()
            ]

    def ask_to_send(self, device_id: str, volume_id: int) -> bool:
        """Ask the device to send one volume. False when it isn't in the device's catalog."""
        vol = self.volume(device_id, volume_id)
        if vol is None:
            return False
        with self.lock:
            queue = self.pending.setdefault(device_id, [])
            if not any(r["volumeId"] == volume_id for r in queue):
                queue.append({"id": secrets.token_hex(6), "kind": "send", "volumeId": volume_id})
            self.asked[(device_id, volume_id)] = time.time()
            self.changed.notify_all()
        return True

    def waiting_for_pickup(self, device_id: str, volume_id: int) -> bool:
        with self.lock:
            return any(r["volumeId"] == volume_id for r in self.pending.get(device_id, []))

    def forget(self, device_id: str) -> None:
        with self.lock:
            self.catalogs.pop(device_id, None)
            self.pending.pop(device_id, None)
        try:
            self._catalog_file(device_id).unlink()
        except OSError:
            pass


def rel_of(vol: dict) -> str:
    """Where a device's volume lands in this PC's library when it's sent."""
    return f"{vol['folder']}/{vol['file']}" if vol["folder"] else vol["file"]
