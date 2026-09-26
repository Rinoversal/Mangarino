"""A device's library on this PC: its catalog, covers, and volumes sent on request.

Run:  tools/panelizer/.venv/Scripts/python.exe -m unittest discover -s tools/hub/tests
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mangarino_hub import winutil  # noqa: E402
from mangarino_hub.app import Hub  # noqa: E402
from mangarino_hub.config import Config  # noqa: E402
from mangarino_hub.remote import RemoteLibraries  # noqa: E402

winutil.firewall_check = lambda port: {"allowRule": True, "blocked": 0, "profiles": []}


def cbz(pages: int = 3) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for i in range(pages):
            z.writestr(f"{i + 1:03d}.jpg", b"\xff\xd8page" + bytes([i]) + b"\xff\xd9")
    return out.getvalue()


def jpeg() -> bytes:
    try:
        from PIL import Image
    except ImportError:
        raise unittest.SkipTest("Pillow is needed for cover images")
    out = io.BytesIO()
    Image.new("RGB", (900, 1350), (30, 60, 200)).save(out, "JPEG", quality=95)
    return out.getvalue()


CATALOG = {"series": [
    {"id": 1, "title": "Berserk", "volumes": [
        {"id": 11, "file": "Berserk v01.cbz", "folder": "Berserk", "key": "berserk/berserk v01.cbz", "size": 0, "pages": 3, "kind": "cbz", "cover": "a"},
        {"id": 12, "file": "Berserk v02.cbz", "folder": "Berserk", "key": "berserk/berserk v02.cbz", "size": 0, "pages": 3, "kind": "cbz", "cover": "b"},
    ]},
    {"id": 2, "title": "Vagabond", "volumes": [
        {"id": 21, "file": "Vagabond v01.cbz", "folder": "Vagabond", "key": "vagabond/vagabond v01.cbz", "size": 0, "pages": 3, "kind": "cbz", "cover": "c"},
    ]},
]}


class RemoteLibraryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        (base / "Manga").mkdir()
        cfg = Config(base / "hub.json")
        cfg.update(library_root=str(base / "Manga"), port=0)
        self.cache = base / "cache"
        self.hub = Hub(cfg, host="127.0.0.1", log=lambda *a: None, panels=False, cache=self.cache)
        self.hub.start()
        self.base = f"http://127.0.0.1:{self.hub.port}"
        self.admin = {"X-Admin-Key": self.hub.admin_key}
        pair = {"code": self.hub.pairing.current_code(), "deviceId": "tab", "deviceName": "Tab S10", "deviceKind": "tablet"}
        self.token = self.call("/api/pair", pair, "POST")[1]["token"]
        self.auth = {"Authorization": f"Bearer {self.token}"}

    def tearDown(self):
        self.hub.shutdown()
        self.tmp.cleanup()

    def call(self, path, body=None, method=None, headers=None, raw=None, timeout=30):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                content = r.read()
                return r.status, (json.loads(content) if r.headers.get("Content-Type", "").startswith("application/json") else content)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_catalog_and_covers(self):
        status, res = self.call("/api/catalog", CATALOG, "POST", self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(res["missingCovers"], [11, 21, 12])  # each series' first volume first
        self.assertEqual(self.call("/api/catalog", CATALOG, "POST")[0], 401)
        big = jpeg()
        self.assertEqual(self.call("/api/device-cover/11", raw=big, method="PUT", headers=self.auth)[0], 200)
        status, body = self.call(f"/admin/remote/tab/cover/11?k={self.hub.admin_key}")
        self.assertEqual(status, 200)
        self.assertLess(len(body), len(big))
        self.assertEqual(self.call("/api/catalog", CATALOG, "POST", self.auth)[1]["missingCovers"], [21, 12])
        devices = self.call("/admin/remote", headers=self.admin)[1]["devices"]
        self.assertEqual([(d["name"], d["kind"], len(d["series"])) for d in devices], [("Tab S10", "tablet", 2)])
        self.assertEqual(self.call("/api/device-cover/99", raw=big, method="PUT", headers=self.auth)[0], 404)

    def test_pc_asks_device_sends_volume_opens(self):
        self.call("/api/catalog", CATALOG, "POST", self.auth)
        st = self.call("/admin/remote/tab/want/12", {}, "POST", self.admin)[1]
        self.assertEqual((st["state"], st["listening"]), ("waiting", False))
        # The device, open and listening, gets the request...
        status, res = self.call("/api/requests?wait=5", headers=self.auth)
        self.assertEqual([(r["kind"], r["volumeId"]) for r in res["requests"]], [("send", 12)])
        self.assertEqual(self.call("/admin/remote/tab/want/12", headers=self.admin)[1]["state"], "starting")
        # ...and sends it the usual way.
        data = cbz()
        q = urllib.parse.urlencode({"folder": "Berserk", "file": "Berserk v02.cbz", "size": len(data)})
        req = urllib.request.Request(f"{self.base}/api/upload?{q}", data=data, method="PUT")
        req.add_header("Authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(req, timeout=30) as r:
            self.assertEqual(r.status, 201)
        for _ in range(50):
            st = self.call("/admin/remote/tab/want/12", headers=self.admin)[1]
            if st["state"] == "ready":
                break
            time.sleep(0.1)
        self.assertEqual(st["state"], "ready")
        pages = self.call(f"/admin/pages/{st['volumeId']}", headers=self.admin)[1]["pages"]
        self.assertEqual(len(pages), 3)
        # Asking again for a volume that is here now just says so.
        self.assertEqual(self.call("/admin/remote/tab/want/12", {}, "POST", self.admin)[1]["state"], "ready")

    def test_a_request_that_went_nowhere_is_asked_again(self):
        self.call("/api/catalog", CATALOG, "POST", self.auth)
        self.call("/admin/remote/tab/want/12", {}, "POST", self.admin)
        self.call("/api/requests?wait=5", headers=self.auth)  # taken, but say the answer got lost
        self.assertEqual(self.call("/admin/remote/tab/want/12", headers=self.admin)[1]["state"], "starting")
        remote = self.hub.remote
        with remote.lock:
            remote.asked[("tab", 12)] -= 30  # nothing happened for half a minute
        self.assertEqual(self.call("/admin/remote/tab/want/12", headers=self.admin)[1]["state"], "waiting")
        res = self.call("/api/requests?wait=5", headers=self.auth)[1]
        self.assertEqual([r["volumeId"] for r in res["requests"]], [12])

    def test_request_reaches_a_waiting_device_at_once(self):
        self.call("/api/catalog", CATALOG, "POST", self.auth)
        threading.Timer(0.4, lambda: self.call("/admin/remote/tab/want/21", {}, "POST", self.admin)).start()
        start = time.time()
        res = self.call("/api/requests?wait=10", headers=self.auth)[1]
        self.assertEqual([r["volumeId"] for r in res["requests"]], [21])
        self.assertLess(time.time() - start, 5)
        self.assertEqual(self.call("/admin/remote/tab/want/77", {}, "POST", self.admin)[1]["state"], "gone")

    def test_catalog_is_kept_and_forgotten_with_the_device(self):
        self.call("/api/catalog", CATALOG, "POST", self.auth)
        again = RemoteLibraries(self.hub.packer.dir)
        self.assertEqual(again.volume("tab", 21)["file"], "Vagabond v01.cbz")
        self.call("/admin/forget", {"deviceId": "tab"}, "POST", self.admin)
        self.assertEqual(self.call("/admin/remote", headers=self.admin)[1]["devices"], [])
        self.assertIsNone(RemoteLibraries(self.hub.packer.dir).volume("tab", 21))

    def test_panel_data_once_the_pc_made_it(self):
        lib = Path(self.hub.library.root) / "Berserk"
        lib.mkdir()
        doc = {"bubbles": "m", "pages": {"001.jpg": {"w": 100, "h": 150, "panels": [{"x": 1, "y": 2, "w": 30, "h": 40}]}}}
        for name, panels in (("ready.cbz", doc), ("old.cbz", {"pages": {}})):
            with zipfile.ZipFile(lib / name, "w") as z:
                z.writestr("001.jpg", b"\xff\xd8x\xff\xd9")
                z.writestr("mangarino-panels.json", json.dumps(panels))
        old = time.time() - 3600
        for f in lib.iterdir():
            os.utime(f, (old, old))
        self.hub.library.scan()
        vols = {v["file"]: v for s in self.call("/admin/library", headers=self.admin)[1]["series"] for v in s["volumes"]}
        status, res = self.call(f"/api/panels/{vols['ready.cbz']['id']}", headers=self.auth)
        self.assertEqual((status, res["doc"]["pages"]["001.jpg"]["panels"][0]["w"]), (200, 30))
        self.assertEqual(res["version"], vols["ready.cbz"]["version"])
        self.assertEqual(self.call(f"/api/panels/{vols['old.cbz']['id']}", headers=self.auth)[1]["error"], "not_ready")
        self.assertEqual(self.call(f"/api/panels/{vols['ready.cbz']['id']}")[0], 401)

    def test_bad_catalogs_are_trimmed(self):
        messy = {"series": [{"title": "X" * 999, "volumes": [{"file": ""}, {"file": "ok.cbz", "size": "12", "kind": "weird"}, "junk"]}, "junk", {"volumes": []}]}
        self.call("/api/catalog", messy, "POST", self.auth)
        series = self.call("/admin/remote", headers=self.admin)[1]["devices"][0]["series"]
        self.assertEqual(len(series), 1)
        self.assertEqual(len(series[0]["title"]), 300)
        self.assertEqual([(v["file"], v["size"], v["kind"]) for v in series[0]["volumes"]], [("ok.cbz", 12, "cbz")])


if __name__ == "__main__":
    unittest.main()
