"""Progress sync and the PC reader's data endpoints.

Run:  tools/panelizer/.venv/Scripts/python.exe -m unittest discover -s tools/hub/tests
"""
from __future__ import annotations

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
from mangarino_hub.progress import ProgressStore, progress_key  # noqa: E402

winutil.firewall_check = lambda port: {"allowRule": True, "blocked": 0, "profiles": []}
OLD = time.time() - 3600


class ProgressStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "progress.json"
        self.store = ProgressStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def row(self, page, t, key="Berserk/Berserk v01.cbz", **kw):
        return {"key": key, "page": page, "panel": None, "completed": False, "updatedMs": t, **kw}

    def test_newest_change_wins(self):
        self.assertEqual(self.store.merge([self.row(10, 1000)]), 1)
        self.assertEqual(self.store.merge([self.row(3, 900)]), 0)  # older: ignored
        self.assertEqual(self.store.merge([self.row(20, 2000)]), 1)
        self.assertEqual(self.store.get("berserk/berserk v01.cbz")["page"], 20)

    def test_since_returns_only_later_changes(self):
        self.store.merge([self.row(1, 1000)])
        rev = self.store.rev
        self.store.merge([self.row(5, 2000, key="Berserk/Berserk v02.cbz")])
        changed = self.store.since(rev)
        self.assertEqual([r["key"] for r in changed["rows"]], ["berserk/berserk v02.cbz"])
        self.assertEqual(self.store.since(changed["rev"])["rows"], [])

    def test_bad_rows_are_ignored_and_state_persists(self):
        self.assertEqual(self.store.merge([{"key": ""}, {"page": 1}, self.row(-1, 5), "junk", self.row(4, 3000)]), 1)
        again = ProgressStore(self.path)
        self.assertEqual(again.get(progress_key("Berserk", "Berserk v01.cbz"))["page"], 4)
        self.assertEqual(again.rev, self.store.rev)

    def test_a_clock_set_ahead_cannot_freeze_a_volume(self):
        now = [1_000_000.0]
        self.store = ProgressStore(self.path, clock=lambda: now[0])
        year = 365 * 86400 * 1000
        self.assertEqual(self.store.merge([self.row(10, int(now[0] * 1000) + year)]), 1)  # held to 5 minutes ahead
        self.assertEqual(self.store.merge([self.row(11, int(now[0] * 1000))]), 0)  # so a read now still loses...
        now[0] += 301
        self.assertEqual(self.store.merge([self.row(42, int(now[0] * 1000))]), 1)  # ...but not for long
        self.assertEqual(self.store.get("berserk/berserk v01.cbz")["page"], 42)
        self.assertEqual(self.store.merge([{"key": "a/b.cbz", "page": 1, "panel": None, "completed": False, "updatedMs": float("inf")}]), 0)

    def test_keys_match_whatever_the_case_or_accent_form(self):
        self.store.merge([self.row(7, 1000, key="Pokémon/Pokémon v01.cbz".upper())])
        self.assertEqual(self.store.get(progress_key("Pokémon", "Pokémon v01.cbz".replace("é", "é")))["page"], 7)


class ReaderEndpointsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        lib = base / "Manga"
        (lib / "Berserk").mkdir(parents=True)
        self.p10 = b"\xff\xd8page10\xff\xd9"
        with zipfile.ZipFile(lib / "Berserk" / "Berserk v01.cbz", "w") as z:
            z.writestr("p10.jpg", self.p10)
            z.writestr("p2.jpg", b"\xff\xd8page2\xff\xd9")
            z.writestr("__MACOSX/._p2.jpg", b"junk")
            z.writestr("notes.txt", b"not a page")
            z.writestr("mangarino-panels.json", json.dumps({"bubbles": "m", "growth": 3, "pages": {
                "p2.jpg": {"w": 100, "h": 150, "panels": [{"x": 1, "y": 2, "w": 30, "h": 40}]}}}))
        (lib / "Oneshot").mkdir()
        for n in (1, 2, 3, 4, 5):
            (lib / "Oneshot" / f"{n}.png").write_bytes(b"\x89PNG" + bytes([n]))
        for p in lib.rglob("*"):
            os.utime(p, (OLD, OLD))
        cfg = Config(base / "hub.json")
        cfg.update(library_root=str(lib), port=0)
        self.hub = Hub(cfg, host="127.0.0.1", log=lambda *a: None, panels=False, cache=base / "cache")
        self.hub.start()
        self.base = f"http://127.0.0.1:{self.hub.port}"
        self.key = {"X-Admin-Key": self.hub.admin_key}

    def tearDown(self):
        self.hub.shutdown()
        self.tmp.cleanup()

    def get(self, path, headers=None, data=None, method=None):
        req = urllib.request.Request(self.base + path, data=data, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def vol(self, title):
        lib = json.loads(self.get("/admin/library", self.key)[2])
        return next(s for s in lib["series"] if s["title"] == title)["volumes"][0]

    def test_pages_are_in_natural_order_without_junk_and_carry_panels(self):
        v = self.vol("Berserk")
        pages = json.loads(self.get(f"/admin/pages/{v['id']}", self.key)[2])["pages"]
        self.assertEqual([p["name"] for p in pages], ["p2.jpg", "p10.jpg"])
        self.assertEqual(pages[0]["panels"], [{"x": 1, "y": 2, "w": 30, "h": 40}])
        self.assertEqual((pages[0]["w"], pages[0]["h"]), (100, 150))
        self.assertEqual(pages[1]["panels"], [])

    def test_page_images_and_covers(self):
        v = self.vol("Berserk")
        status, headers, body = self.get(f"/admin/page/{v['id']}/1?k={self.hub.admin_key}")
        self.assertEqual((status, body, headers["Content-Type"]), (200, self.p10, "image/jpeg"))
        self.assertEqual(self.get(f"/admin/cover/{v['id']}?k={self.hub.admin_key}")[2], b"\xff\xd8page2\xff\xd9")
        self.assertEqual(self.get(f"/admin/page/{v['id']}/9?k={self.hub.admin_key}")[0], 404)
        self.assertEqual(self.get(f"/admin/page/{v['id']}/1?k=wrong")[0], 403)

    def test_folder_volumes_read_too(self):
        v = self.vol("Oneshot")
        pages = json.loads(self.get(f"/admin/pages/{v['id']}", self.key)[2])["pages"]
        self.assertEqual([p["name"] for p in pages], ["1.png", "2.png", "3.png", "4.png", "5.png"])
        self.assertEqual(self.get(f"/admin/page/{v['id']}/4?k={self.hub.admin_key}")[2], b"\x89PNG\x05")

    def test_progress_round_trip_between_device_and_reader(self):
        pair = json.dumps({"code": self.hub.pairing.current_code(), "deviceId": "tab", "deviceName": "Tab"}).encode()
        token = json.loads(self.get("/api/pair", data=pair, method="POST")[2])["token"]
        auth = {"Authorization": f"Bearer {token}"}
        row = {"key": "Berserk/Berserk v01.cbz", "page": 12, "panel": 2, "completed": False, "updatedMs": 5000}
        res = json.loads(self.get("/api/progress", auth, json.dumps({"rows": [row]}).encode(), "POST")[2])
        self.assertEqual(res["accepted"], 1)
        seen = json.loads(self.get("/admin/progress?since=0", self.key)[2])
        self.assertEqual(seen["rows"][0]["page"], 12)
        newer = {**row, "page": 30, "updatedMs": 9000}
        self.get("/admin/progress", self.key, json.dumps({"rows": [newer]}).encode(), "POST")
        back = json.loads(self.get(f"/api/progress?since={res['rev']}", auth)[2])
        self.assertEqual([r["page"] for r in back["rows"]], [30])
        status = json.loads(self.get("/admin/status", self.key)[2])
        self.assertTrue(status["devices"][0]["online"])

    def test_reader_page_is_served_with_the_key(self):
        status, _, body = self.get("/read")
        self.assertEqual(status, 200)
        self.assertIn(self.hub.admin_key.encode(), body)


if __name__ == "__main__":
    unittest.main()
