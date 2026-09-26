"""Folder volumes and junk files: the hub must see a library exactly the way the app does.

Run:  tools/panelizer/.venv/Scripts/python.exe -m unittest discover -s tools/hub/tests
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mangarino_hub import winutil  # noqa: E402
from mangarino_hub.app import Hub  # noqa: E402
from mangarino_hub.config import Config  # noqa: E402
from mangarino_hub.library import (  # noqa: E402
    COVER_IMAGES_MAX,
    Library,
    folder_images_are_volume,
    is_junk_name,
    is_page_image,
    packed_size,
    read_dir_panels_state,
)
from mangarino_hub.packer import Packer  # noqa: E402

winutil.firewall_check = lambda port: {"allowRule": True, "blocked": 0, "profiles": []}
OLD = time.time() - 3600


def touch_old(root: Path) -> None:
    for p in root.rglob("*"):
        os.utime(p, (OLD, OLD))


def img(path: Path, n: int = 1000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xd8" + os.urandom(n) + b"\xff\xd9")


def pages(folder: Path, count: int, fmt: str = "p{:d}.jpg") -> None:
    for i in range(1, count + 1):
        img(folder / fmt.format(i))


class PageOrderTest(unittest.TestCase):
    # The same list and order are checked for the app in __tests__/parse.test.ts (pageCompare).
    ORDERED = [
        "001.jpg", "2.jpg", "010.jpg", "Ch 2/1.jpg", "Ch 2/9.jpg", "Ch 2/10.jpg", "Ch 10/1.jpg",
        "image.png", "image (1).png", "image (2).png", "image (10).png",
        "IMG_20240101_0002.jpg", "IMG_20240101_0010.jpg",
    ]

    def test_pages_are_in_reading_order(self):
        from mangarino_hub.library import page_key

        self.assertEqual(sorted(reversed(self.ORDERED), key=page_key), self.ORDERED)


class RulesTest(unittest.TestCase):
    """Same cases as __tests__/layout.test.ts, so the app and the hub agree."""

    def test_junk_and_pages(self):
        for name in ("._p001.jpg", ".DS_Store", "__MACOSX", "Thumbs.db", "desktop.ini", ".hidden"):
            self.assertTrue(is_junk_name(name), name)
        self.assertFalse(is_page_image("._p001.jpg"))
        for name in ("p001.jpg", "P001.JPEG", "page.png", "x.webp", "x.avif", "x.gif", "x.bmp"):
            self.assertTrue(is_page_image(name), name)
        for name in ("notes.txt", "info.nfo", "site.url", "book.pdf", "p001.jpg.part"):
            self.assertFalse(is_page_image(name), name)

    def test_folder_images_are_volume(self):
        self.assertTrue(folder_images_are_volume(1, False, False))
        self.assertTrue(folder_images_are_volume(180, False, False))
        for n in range(1, COVER_IMAGES_MAX + 1):
            self.assertFalse(folder_images_are_volume(n, False, True))
        self.assertTrue(folder_images_are_volume(COVER_IMAGES_MAX + 1, False, True))
        self.assertFalse(folder_images_are_volume(50, True, False))
        self.assertFalse(folder_images_are_volume(0, False, False))


class DiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "Manga"

    def tearDown(self):
        self.tmp.cleanup()

    def files(self):
        touch_old(self.root)
        lib = Library(str(self.root))
        lib.scan()
        return sorted((v.folder, v.file, v.kind) for v in lib.volumes.values())

    def test_a_messy_real_world_library(self):
        r = self.root
        # Volume folders, a series cover, and junk next to them
        pages(r / "Vagabond" / "Vol 01", 20)
        pages(r / "Vagabond" / "Vol 02", 20)
        img(r / "Vagabond" / "cover.jpg")
        (r / "Vagabond" / "info.nfo").write_text("x")
        (r / "Vagabond" / "Thumbs.db").write_bytes(b"x")
        # macOS leftovers: a __MACOSX folder and ._ files
        pages(r / "Vagabond" / "__MACOSX" / "Vol 01", 20, "._p{:d}.jpg")
        img(r / "Vagabond" / "Vol 01" / "._p1.jpg")
        # A volume folder that holds a cover plus chapter folders
        img(r / "Monster" / "Vol 01" / "cover.jpg")
        pages(r / "Monster" / "Vol 01" / "Ch 001", 15)
        pages(r / "Monster" / "Vol 01" / "Ch 002", 15)
        # Many pages with an extras folder: the pages are the volume
        pages(r / "Pluto" / "Vol 01", 30)
        pages(r / "Pluto" / "Vol 01" / "extras", 2)
        # A one-shot: pages straight in the series folder
        pages(r / "Oneshot", 12)
        # Archives with images beside them: the images are extras
        (r / "Berserk").mkdir(parents=True)
        with zipfile.ZipFile(r / "Berserk" / "Berserk v01.zip", "w") as z:
            z.writestr("p1.jpg", b"x")
        pages(r / "Berserk", 5, "promo{:d}.jpg")
        # A loose archive and loose junk in the root
        with zipfile.ZipFile(r / "Loose v01.cbz", "w") as z:
            z.writestr("p1.jpg", b"x")
        (r / "readme.txt").write_text("x")
        self.assertEqual(self.files(), [
            ("", "Loose v01.cbz", "file"),
            ("Berserk", "Berserk v01.zip", "file"),
            ("Monster", "Vol 01 Ch 001.cbz", "folder"),
            ("Monster", "Vol 01 Ch 002.cbz", "folder"),
            ("Oneshot", "Oneshot.cbz", "folder"),
            ("Pluto", "Vol 01.cbz", "folder"),
            ("Vagabond", "Vol 01.cbz", "folder"),
            ("Vagabond", "Vol 02.cbz", "folder"),
        ])

    def test_folder_volume_pages_skip_junk_and_sort_naturally(self):
        pages(self.root / "S" / "Vol 01", 12)
        img(self.root / "S" / "Vol 01" / "._p3.jpg")
        (self.root / "S" / "Vol 01" / "notes.txt").write_text("x")
        touch_old(self.root)
        lib = Library(str(self.root))
        lib.scan()
        (v,) = lib.volumes.values()
        self.assertEqual([n for n, _ in v.entries], [f"p{i}.jpg" for i in range(1, 13)])

    def test_panels_json_in_a_folder(self):
        folder = self.root / "S" / "Vol 01"
        pages(folder, 4)
        self.assertEqual(read_dir_panels_state(folder), "none")
        (folder / "mangarino-panels.json").write_text(json.dumps({"pages": {}}))
        self.assertEqual(read_dir_panels_state(folder), "old")
        (folder / "mangarino-panels.json").write_text(json.dumps({"bubbles": "m", "growth": 3, "pages": {}}))
        self.assertEqual(read_dir_panels_state(folder), "ready")


class PackerTest(unittest.TestCase):
    def test_packed_size_counts_zip64_past_2_gib(self):
        import io

        class Sink(io.RawIOBase):  # counts what zipfile writes, keeps nothing
            pos = size = 0

            def writable(self):
                return True

            def seekable(self):
                return True

            def write(self, b):
                self.pos += len(b)
                self.size = max(self.size, self.pos)
                return len(b)

            def seek(self, off, whence=0):
                self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
                return self.pos

            def tell(self):
                return self.pos

        entries = [("p001.jpg", 900_000_000), ("p002.jpg", 900_000_000), ("p003.jpg", 400_000_000), ("p004.jpg", 1000)]
        sink = Sink()
        chunk = bytes(1 << 20)
        with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
            for name, size in entries:
                with z.open(zipfile.ZipInfo(name), "w") as f:
                    left = size
                    while left:
                        n = min(left, len(chunk))
                        f.write(chunk[:n])
                        left -= n
        self.assertGreater(sink.size, zipfile.ZIP64_LIMIT)
        self.assertEqual(sink.size, packed_size(entries))

    def test_packed_size_is_exact_and_pages_are_in_order(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "Manga"
            folder = root / "S" / "Vol 01"
            for i in (1, 2, 10, 3):
                img(folder / f"p{i}.jpg", 500 + i)
            img(folder / "ページ.jpg")  # a non-ASCII name
            (folder / "mangarino-panels.json").write_text(json.dumps({"bubbles": "m", "growth": 3, "pages": {}}))
            touch_old(root)
            lib = Library(str(root))
            lib.scan()
            (v,) = lib.volumes.values()
            self.assertEqual(v.size, packed_size(v.entries))
            out = Packer(Path(d) / "cache").ensure(v)
            self.assertEqual(out.stat().st_size, v.size)
            with zipfile.ZipFile(out) as z:
                self.assertEqual(z.namelist(), ["p1.jpg", "p2.jpg", "p3.jpg", "p10.jpg", "ページ.jpg", "mangarino-panels.json"])
                self.assertIsNone(z.testzip())


class FolderDownloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.lib = base / "Manga"
        pages(self.lib / "Vagabond" / "Vol 01", 8)
        touch_old(self.lib)
        cfg = Config(base / "hub.json")
        cfg.update(library_root=str(self.lib), port=0)
        self.hub = Hub(cfg, host="127.0.0.1", log=lambda *a: None, panels=False, cache=base / "cache")
        self.hub.start()
        self.base = f"http://127.0.0.1:{self.hub.port}"
        req = urllib.request.Request(self.base + "/api/pair", method="POST", data=json.dumps(
            {"code": self.hub.pairing.current_code(), "deviceId": "t", "deviceName": "T"}).encode())
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req) as r:
            self.token = json.loads(r.read())["token"]

    def tearDown(self):
        self.hub.shutdown()
        self.tmp.cleanup()

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path)
        req.add_header("Authorization", f"Bearer {self.token}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_a_folder_volume_downloads_as_a_cbz(self):
        listing = json.loads(self.get("/api/library")[2])
        (series,) = listing["series"]
        (vol,) = series["volumes"]
        self.assertEqual((series["folder"], vol["file"], vol["kind"]), ("Vagabond", "Vol 01.cbz", "folder"))
        self.assertEqual(self.get(f"/api/volume/{vol['id']}")[0], 200)  # packs it
        status, headers, body = self.get(f"/api/file/{vol['id']}?v={vol['version']}")
        self.assertEqual((status, len(body)), (200, vol["size"]))
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            self.assertEqual(z.namelist(), [f"p{i}.jpg" for i in range(1, 9)])
        status, _, part = self.get(f"/api/file/{vol['id']}", {"Range": "bytes=100-199"})
        self.assertEqual((status, part), (206, body[100:200]))


if __name__ == "__main__":
    unittest.main()
