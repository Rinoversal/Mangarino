"""Packs folder volumes (a folder of page images) into a .cbz for devices.

Pages are stored uncompressed (images are already compressed), in the app's natural order,
plus the folder's mangarino-panels.json when there is one. The result's size is known in
advance (library.packed_size), so devices can check free space and show progress. Packed
files are cached per volume version, least recently used first out, within CACHE_CAP_BYTES.
"""
from __future__ import annotations

import hashlib
import os
import threading
import zipfile
from pathlib import Path

from . import brand

CACHE_CAP_BYTES = 8 * 1024**3


class Changed(Exception):
    """The folder changed since the last scan; rescan and ask again."""


def cache_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / brand.FOLDER / "hub-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


class Packer:
    def __init__(self, directory: Path | None = None, cap: int = CACHE_CAP_BYTES):
        self.dir = directory or cache_dir()
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cap = cap
        self._locks: dict[str, threading.Lock] = {}
        self._locks_lock = threading.Lock()
        for stale in self.dir.glob("*.tmp"):  # from a hub that was closed mid-pack
            try:
                stale.unlink()
            except OSError:
                pass

    def path_for(self, v) -> Path:
        return self.dir / f"{v.id}-{hashlib.sha1(v.version.encode()).hexdigest()[:10]}.cbz"

    def _lock(self, vid: str) -> threading.Lock:
        with self._locks_lock:
            return self._locks.setdefault(vid, threading.Lock())

    def ensure(self, v) -> Path:
        """The packed .cbz for folder volume `v`, building it if needed."""
        out = self.path_for(v)
        with self._lock(v.id):
            if out.is_file() and out.stat().st_size == v.size:
                os.utime(out, None)  # mark as recently used
                return out
            tmp = out.with_name(out.name + ".tmp")
            try:
                with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True, strict_timestamps=False) as z:
                    for name, size in v.entries:
                        src = v.path / name
                        if src.stat().st_size != size:
                            raise Changed(str(src))
                        z.write(src, name)
                if tmp.stat().st_size != v.size:
                    raise Changed(str(v.path))
                os.replace(tmp, out)
            except (OSError, Changed):
                try:
                    tmp.unlink()
                except OSError:
                    pass
                raise
        self._prune(keep=out, vid=v.id)
        return out

    def _prune(self, keep: Path, vid: str) -> None:
        files = []
        for f in self.dir.glob("*.cbz"):
            if f == keep:
                continue
            if f.name.startswith(vid + "-"):  # an older version of the same volume
                self._unlink(f)
                continue
            try:
                st = f.stat()
                files.append((st.st_mtime, st.st_size, f))
            except OSError:
                pass
        total = sum(s for _, s, _ in files) + (keep.stat().st_size if keep.exists() else 0)
        for _, size, f in sorted(files):
            if total <= self.cap:
                break
            if self._unlink(f):
                total -= size

    @staticmethod
    def _unlink(f: Path) -> bool:
        try:
            f.unlink()
            return True
        except OSError:  # still being sent to a device (Windows keeps open files); next time
            return False
