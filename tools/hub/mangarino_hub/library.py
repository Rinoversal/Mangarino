"""The PC's manga folder, as the app sees it.

Layout rules, the same as the app's scanner (src/library/scanner.ts + layout.ts):
  root/*.cbz|zip                  loose volumes
  root/<Series>/*.cbz|zip         volumes of that series (also one folder deeper)
  root/<Series>/<Vol>/*.jpg       a folder volume
  root/<Series>/<Vol>/<Ch>/*.jpg  a folder volume named "<Vol> <Ch>"
  root/<Series>/*.jpg             the series folder itself is one volume
Only archives and page images count: text files, shortcuts, macOS `._` files and `__MACOSX`
folders, Thumbs.db and the like are ignored. Up to 3 loose images next to volume or chapter
folders are cover art, not a volume.

Folder volumes are offered to devices as a .cbz, packed on demand (see packer.py), with the
exact size of that .cbz. A volume is offered only when complete: nothing in it was touched
for a minute, or it stayed the same across two scans 10 s apart, and (for archives) its zip
directory reads cleanly. So a copy still in progress never reaches a device.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

JSON_ENTRY = "mangarino-panels.json"
ARCHIVE_EXTS = (".cbz", ".zip")
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp")
COVER_IMAGES_MAX = 3
STABLE_AGE_S = 60.0
STABLE_WINDOW_S = 10.0
_TOKEN = re.compile(r"\d+|\D+")


# ---------------------------------------------------------------------- rules (mirror layout.ts)
def is_junk_name(name: str) -> bool:
    n = name.lower()
    return (
        name.startswith((".", "$", "~"))
        or n in ("__macosx", "thumbs.db", "desktop.ini", "system volume information")
    )


def is_page_image(name: str) -> bool:
    return not is_junk_name(name) and name.lower().endswith(IMAGE_EXTS)


def is_archive_name(name: str) -> bool:
    return not is_junk_name(name) and name.lower().endswith(ARCHIVE_EXTS)


def folder_images_are_volume(own_images: int, has_archives_here: bool, has_sub_volumes: bool) -> bool:
    return not has_archives_here and own_images > 0 and (own_images > COVER_IMAGES_MAX or not has_sub_volumes)


def natural_key(s: str):
    return [(0, int(t), len(t)) if t.isdigit() else (1, t.lower(), 0) for t in _TOKEN.findall(s)]


_EXT = re.compile(r"\.[^./\\]+$")


def page_key(name: str):
    """Reading order of pages: the name without its extension first, so "image.png" comes
    before "image (1).png". Same as pageCompare() in src/library/parse.ts (progress syncs as a
    page number, so both must agree)."""
    return (natural_key(_EXT.sub("", name)), natural_key(name))


def volume_id(rel: str) -> str:
    return hashlib.sha1(rel.lower().encode("utf-8")).hexdigest()[:16]


def packed_size(entries) -> int:
    """Exact size of the .cbz packer.py writes for these (name, size) entries: stored, no
    compression, no extra fields, plus what Python's zipfile adds once the archive passes 2 GiB:
    an 8-byte offset field on each directory entry beyond that point, and the zip64 end records."""
    offset = central = count = 0
    for name, size in entries:
        n = len(name.encode("utf-8"))
        central += 46 + n + (12 if offset > zipfile.ZIP64_LIMIT else 0)
        offset += 30 + n + size
        count += 1
    zip64_end = count > zipfile.ZIP_FILECOUNT_LIMIT or offset > zipfile.ZIP64_LIMIT or central > zipfile.ZIP64_LIMIT
    return offset + central + 22 + (56 + 20 if zip64_end else 0)


def _is_link(entry: os.DirEntry) -> bool:
    """Symlinks and Windows junctions are never followed, so nothing outside the root is served."""
    if entry.is_symlink():
        return True
    try:
        attrs = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return True
    return bool(attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


GROWTH = 3  # panelize.py's growth rules: files made with older ones are redone


def _state_of(raw: bytes) -> str:
    doc = json.loads(raw.decode("utf-8"))
    if not isinstance(doc, dict) or not doc.get("bubbles"):
        return "old"
    growth = doc.get("growth")
    return "ready" if isinstance(growth, int) and growth >= GROWTH else "old"


def read_panels_state(path: Path) -> str:
    """For an archive: "none", "old" (panels without bubble growth), "ready", or "bad"."""
    try:
        with zipfile.ZipFile(path) as z:
            try:
                info = z.getinfo(JSON_ENTRY)
            except KeyError:
                return "none"
            if info.file_size > 20_000_000:
                return "old"
            return _state_of(z.read(info))
    except (zipfile.BadZipFile, OSError, ValueError, UnicodeDecodeError, EOFError):
        return "bad"


def _page_entry(name: str) -> bool:
    """An image entry inside an archive, skipping macOS and Windows leftovers (like the app)."""
    norm = name.replace("\\", "/")
    if norm.endswith("/") or norm.startswith("__MACOSX/") or "/__MACOSX/" in norm:
        return False
    return is_page_image(norm.rsplit("/", 1)[-1])


_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
         ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp"}


def mime_of(name: str) -> str:
    return _MIME.get(os.path.splitext(name)[1].lower(), "application/octet-stream")


def volume_pages(v) -> list[dict]:
    """The volume's pages in reading order (the app's natural sort), each with its size and
    panel boxes when the volume has panels: [{name, w, h, panels: [{x, y, w, h}]}]."""
    doc: dict = {}
    if v.kind == "folder":
        names = [n for n, _ in v.entries if n != JSON_ENTRY]
        js = v.path / JSON_ENTRY
        if js.is_file():
            try:
                doc = json.loads(js.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                doc = {}
    else:
        with zipfile.ZipFile(v.path) as z:
            names = sorted((n for n in z.namelist() if _page_entry(n)), key=page_key)
            if JSON_ENTRY in z.namelist():
                try:
                    doc = json.loads(z.read(JSON_ENTRY).decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    doc = {}
    pages = doc.get("pages", doc) if isinstance(doc, dict) else {}
    out = []
    for n in names:
        p = pages.get(n) if isinstance(pages, dict) else None
        if isinstance(p, list):
            p = {"panels": p}
        p = p if isinstance(p, dict) else {}
        out.append({"name": n, "w": p.get("w"), "h": p.get("h"), "panels": p.get("panels") or []})
    return out


def page_bytes(v, name: str) -> bytes:
    if v.kind == "folder":
        if name not in {n for n, _ in v.entries}:
            raise KeyError(name)
        return (v.path / name).read_bytes()
    with zipfile.ZipFile(v.path) as z:
        return z.read(name)


def read_panels_doc(v) -> dict | None:
    """A volume's mangarino-panels.json, parsed (None when it has none or it can't be read)."""
    try:
        if v.kind == "folder":
            p = v.path / JSON_ENTRY
            raw = p.read_bytes() if p.is_file() else None
        else:
            with zipfile.ZipFile(v.path) as z:
                raw = z.read(JSON_ENTRY) if JSON_ENTRY in z.namelist() else None
        doc = json.loads(raw.decode("utf-8")) if raw else None
        return doc if isinstance(doc, dict) else None
    except (OSError, zipfile.BadZipFile, ValueError, UnicodeDecodeError, KeyError):
        return None


def read_dir_panels_state(folder: Path) -> str:
    p = folder / JSON_ENTRY
    try:
        return _state_of(p.read_bytes()) if p.is_file() else "none"
    except (OSError, ValueError, UnicodeDecodeError):
        return "old"


# ---------------------------------------------------------------------- volumes
@dataclass
class Volume:
    id: str
    rel: str  # path under the root: "Series/file.cbz" or, for folders, "Series/Vol 01"
    folder: str  # series folder name ("" for loose volumes)
    file: str  # the file name devices see ("<label>.cbz" for folder volumes)
    path: Path
    size: int
    mtime_ns: int
    version: str
    panels: str  # none | old | ready (from disk); the worker overlays working/failed
    kind: str = "file"  # file | folder
    entries: tuple = field(default=())  # folder volumes: (name, size) to pack, pages in order then the JSON


@dataclass
class _Candidate:
    kind: str
    folder: str
    rel: str
    path: Path
    file: str
    size: int
    mtime: float
    mtime_ns: int
    version: str
    entries: tuple = ()


class Library:
    def __init__(self, root: str, clock=time.time, stable_age: float = STABLE_AGE_S, stable_window: float = STABLE_WINDOW_S):
        self.clock, self.stable_age, self.stable_window = clock, stable_age, stable_window
        self.lock = threading.RLock()
        self.scan_lock = threading.Lock()  # one scan at a time
        self.root = Path(root)
        self.volumes: dict[str, Volume] = {}
        self.pending: list[str] = []
        self.unreadable: list[str] = []
        self.generation = 1
        self.last_scan = 0.0
        self.overlay: dict[str, tuple[str, str]] = {}  # id -> (version, working|failed)
        self._seen: dict[str, tuple[str, float]] = {}  # rel -> (version, first seen at)
        self._panels: dict[tuple[str, str], str] = {}  # (rel, version) -> panels state
        self._signature: tuple = ()

    def set_root(self, root: str) -> None:
        with self.scan_lock:
            with self.lock:
                self.root = Path(root)
                self._seen.clear()
                self.volumes = {}
                self.generation += 1
        self.scan()

    # ------------------------------------------------------------------ discovery
    @staticmethod
    def _list(path) -> list:
        try:
            return [e for e in os.scandir(path) if not is_junk_name(e.name) and not _is_link(e)]
        except OSError:
            return []

    @staticmethod
    def _files(items) -> list:
        return [e for e in items if e.is_file(follow_symlinks=False)]

    @staticmethod
    def _dirs(items) -> list:
        return [e for e in items if e.is_dir(follow_symlinks=False)]

    def _file_candidate(self, folder: str, e, rel: str) -> _Candidate | None:
        try:
            st = e.stat(follow_symlinks=False)
        except OSError:
            return None
        return _Candidate("file", folder, rel, Path(e.path), e.name, st.st_size, st.st_mtime, st.st_mtime_ns,
                          f"{st.st_size}-{st.st_mtime_ns}")

    def _folder_candidate(self, folder: str, path: str, rel: str, label: str, items) -> _Candidate | None:
        pages = sorted((f for f in self._files(items) if is_page_image(f.name)), key=lambda f: page_key(f.name))
        if not pages:
            return None
        entries: list[tuple[str, int]] = []
        newest_ns = 0
        try:
            for f in pages:
                st = f.stat(follow_symlinks=False)
                entries.append((f.name, st.st_size))
                newest_ns = max(newest_ns, st.st_mtime_ns)
            js = Path(path) / JSON_ENTRY
            if js.is_file():
                st = js.stat()
                entries.append((JSON_ENTRY, st.st_size))
                newest_ns = max(newest_ns, st.st_mtime_ns)
        except OSError:
            return None
        size = packed_size(entries)
        return _Candidate("folder", folder, rel, Path(path), f"{label}.cbz", size, newest_ns / 1e9, newest_ns,
                          f"d{len(entries)}-{size}-{newest_ns}", tuple(entries))

    def _discover(self) -> list[_Candidate]:
        root = self.root
        if not root.is_dir():
            return []
        out: list = []
        items = self._list(root)
        for e in self._files(items):
            if is_archive_name(e.name):
                out.append(self._file_candidate("", e, e.name))
        for s in self._dirs(items):
            s_items = self._list(s.path)
            archives = [f for f in self._files(s_items) if is_archive_name(f.name)]
            for f in archives:
                out.append(self._file_candidate(s.name, f, f"{s.name}/{f.name}"))
            before = len(out)
            for d in self._dirs(s_items):
                d_items = self._list(d.path)
                for f in self._files(d_items):
                    if is_archive_name(f.name):
                        out.append(self._file_candidate(s.name, f, f"{s.name}/{d.name}/{f.name}"))
                chapters = []
                for leaf in self._dirs(d_items):
                    li = self._list(leaf.path)
                    if any(is_page_image(x.name) for x in self._files(li)):
                        chapters.append((leaf, li))
                own = sum(1 for x in self._files(d_items) if is_page_image(x.name))
                if folder_images_are_volume(own, False, bool(chapters)):
                    out.append(self._folder_candidate(s.name, d.path, f"{s.name}/{d.name}", d.name, d_items))
                    continue
                for leaf, li in chapters:
                    out.append(self._folder_candidate(s.name, leaf.path, f"{s.name}/{d.name}/{leaf.name}", f"{d.name} {leaf.name}", li))
            own = sum(1 for x in self._files(s_items) if is_page_image(x.name))
            if folder_images_are_volume(own, bool(archives), len(out) > before):
                out.append(self._folder_candidate(s.name, s.path, s.name, s.name, s_items))
        return [c for c in out if c is not None]

    # ------------------------------------------------------------------ scanning
    def scan(self) -> bool:
        """Rescan the folder. Returns True when what devices see changed."""
        with self.scan_lock:
            return self._scan()

    def _scan(self) -> bool:
        now = self.clock()
        found: dict[str, Volume] = {}
        pending: list[str] = []
        unreadable: list[str] = []
        seen_now: dict[str, tuple[str, float]] = {}
        for c in self._discover():
            prev = self._seen.get(c.rel)
            first = prev[1] if prev and prev[0] == c.version else now
            seen_now[c.rel] = (c.version, first)
            stable = (now - c.mtime) >= self.stable_age or (
                prev is not None and prev[0] == c.version and now - first >= self.stable_window
            )
            if not stable:
                pending.append(c.rel)
                continue
            key = (c.rel, c.version)
            state = self._panels.get(key)
            if state is None:
                state = read_panels_state(c.path) if c.kind == "file" else read_dir_panels_state(c.path)
                self._panels[key] = state
            if state == "bad":
                unreadable.append(c.rel)
                continue
            vid = volume_id(c.rel)
            found[vid] = Volume(vid, c.rel, c.folder, c.file, c.path, c.size, c.mtime_ns, c.version, state, c.kind, c.entries)
        with self.lock:
            self._seen = seen_now
            self.volumes = found
            self.pending, self.unreadable = sorted(pending), sorted(unreadable)
            self.last_scan = now
            self._panels = {k: s for k, s in self._panels.items() if seen_now.get(k[0], ("",))[0] == k[1]}
            self.overlay = {i: o for i, o in self.overlay.items() if i in found and found[i].version == o[0]}
            return self._refresh_signature()

    def mark_complete(self, rel: str) -> None:
        """The hub wrote this volume itself (an upload, or panels): it is complete, so offer it
        on the next scan instead of waiting out the copy-finished window."""
        with self.scan_lock:
            for c in self._discover():
                if c.rel == rel:
                    self._seen[rel] = (c.version, float("-inf"))
                    return

    def _refresh_signature(self) -> bool:
        sig = tuple(sorted((v.id, v.version, self.panels_of(v)) for v in self.volumes.values()))
        if sig != self._signature:
            self._signature = sig
            self.generation += 1
            return True
        return False

    def ensure_fresh(self, max_age: float = 5.0) -> None:
        if self.clock() - self.last_scan > max_age:
            self.scan()

    # ------------------------------------------------------------------ queries
    def panels_of(self, v: Volume) -> str:
        o = self.overlay.get(v.id)
        return o[1] if o and o[0] == v.version else v.panels

    def set_overlay(self, vid: str, version: str, state: str | None) -> None:
        with self.lock:
            if state is None:
                self.overlay.pop(vid, None)
            else:
                self.overlay[vid] = (version, state)
            self._refresh_signature()

    def get(self, vid: str) -> Volume | None:
        with self.lock:
            return self.volumes.get(vid)

    def listing(self) -> dict:
        with self.lock:
            series: dict[str, list[Volume]] = {}
            for v in self.volumes.values():
                series.setdefault(v.folder, []).append(v)
            out = []
            for folder in sorted(series, key=natural_key):
                vols = sorted(series[folder], key=lambda v: natural_key(v.file))
                out.append({
                    "id": volume_id(folder) if folder else "root",
                    "folder": folder,
                    "title": folder or "Loose files",
                    "volumes": [
                        {
                            "id": v.id,
                            "file": v.file,
                            "kind": v.kind,
                            "size": v.size,
                            "mtimeMs": v.mtime_ns // 1_000_000,
                            "version": v.version,
                            "panels": self.panels_of(v),
                        }
                        for v in vols
                    ],
                })
            return {"generation": self.generation, "rootName": self.root.name, "series": out}

    def summary(self) -> dict:
        with self.lock:
            vols = list(self.volumes.values())
            states: dict[str, int] = {}
            for v in vols:
                s = self.panels_of(v)
                states[s] = states.get(s, 0) + 1
            return {
                "root": str(self.root),
                "exists": self.root.is_dir(),
                "series": len({v.folder for v in vols}),
                "volumes": len(vols),
                "folders": sum(1 for v in vols if v.kind == "folder"),
                "bytes": sum(v.size for v in vols),
                "panels": states,
                "pending": self.pending[:20],
                "unreadable": self.unreadable[:20],
            }
