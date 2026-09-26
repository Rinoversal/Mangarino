"""End-to-end tests for Mangarino Hub: a real server on 127.0.0.1 with a temp library.

Run:  tools/panelizer/.venv/Scripts/python.exe -m unittest discover -s tools/hub/tests
"""
from __future__ import annotations

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
from mangarino_hub.files import Busy, FileGate  # noqa: E402
from mangarino_hub.library import read_panels_state, volume_id  # noqa: E402
from mangarino_hub.pairing import MAX_TRIES  # noqa: E402
from mangarino_hub.server import allowed_client, safe_name  # noqa: E402
import ipaddress  # noqa: E402

winutil.firewall_check = lambda port: {"allowRule": True, "blocked": 0, "profiles": []}  # no PowerShell in tests


def make_cbz(path: Path, pages: int = 3, panels: dict | None = None) -> bytes:
    with zipfile.ZipFile(path, "w") as z:
        for i in range(pages):
            z.writestr(f"p{i:03d}.jpg", b"\xff\xd8" + os.urandom(3000) + b"\xff\xd9")
        if panels is not None:
            z.writestr("mangarino-panels.json", json.dumps(panels))
    return path.read_bytes()


class HubTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.lib = base / "Manga"
        (self.lib / "Berserk").mkdir(parents=True)
        self.v01 = make_cbz(self.lib / "Berserk" / "Berserk v01.cbz")
        make_cbz(self.lib / "Berserk" / "Berserk v02.cbz", panels={"bubbles": "m", "pages": {}})
        make_cbz(self.lib / "Loose v01.cbz", panels={"text": True, "pages": {}})
        old = time.time() - 3600  # untouched for an hour, so complete
        for p in self.lib.rglob("*.cbz"):
            os.utime(p, (old, old))
        cfg = Config(base / "hub.json")
        cfg.update(library_root=str(self.lib), port=0)
        self.hub = Hub(cfg, host="127.0.0.1", log=lambda *a: None, panels=False, cache=base / "cache")
        self.hub.start()
        self.base = f"http://127.0.0.1:{self.hub.port}"

    def tearDown(self):
        self.hub.shutdown()
        self.tmp.cleanup()

    # ---------------------------------------------------------------- helpers
    def call(self, method, path, body=None, token=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def js(self, *a, **k):
        status, headers, body = self.call(*a, **k)
        return status, json.loads(body.decode() or "null")

    def pair(self) -> str:
        status, res = self.js("POST", "/api/pair", {"code": self.hub.pairing.current_code(), "deviceId": "tab1", "deviceName": "Tablet"})
        self.assertEqual(status, 200)
        return res["token"]

    def library(self, token):
        return self.js("GET", "/api/library", token=token)[1]

    def vol(self, token, file):
        for s in self.library(token)["series"]:
            for v in s["volumes"]:
                if v["file"] == file:
                    return v
        return None

    # ---------------------------------------------------------------- pairing
    def test_hello_needs_no_token(self):
        status, res = self.js("GET", "/api/hello")
        self.assertEqual(status, 200)
        self.assertEqual(res["service"], "mangarino-hub")
        self.assertFalse(res["paired"])
        self.assertEqual(res["serverId"], self.hub.config.server_id)

    def test_pairing_with_the_right_code_gives_a_token_and_rotates_the_code(self):
        code = self.hub.pairing.current_code()
        token = self.pair()
        self.assertNotEqual(self.hub.pairing.current_code(), code)
        self.assertTrue(self.js("GET", "/api/hello", token=token)[1]["paired"])
        stored = json.loads(self.hub.config.path.read_text())
        self.assertNotIn(token, json.dumps(stored))  # only a hash is kept

    def test_wrong_codes_count_down_then_the_code_changes(self):
        code = self.hub.pairing.current_code()
        wrong = "000000" if code != "000000" else "111111"
        for left in range(MAX_TRIES - 1, 0, -1):
            status, res = self.js("POST", "/api/pair", {"code": wrong, "deviceId": "x", "deviceName": "x"})
            self.assertEqual((status, res["error"], res["attemptsLeft"]), (403, "bad_code", left))
        status, res = self.js("POST", "/api/pair", {"code": wrong, "deviceId": "x", "deviceName": "x"})
        self.assertEqual(res["error"], "code_changed")
        self.assertNotEqual(self.hub.pairing.current_code(), code)

    def test_api_needs_a_token(self):
        self.assertEqual(self.call("GET", "/api/library")[0], 401)
        self.assertEqual(self.call("GET", "/api/library", token="nope")[0], 401)

    def test_forgetting_revokes_the_token(self):
        token = self.pair()
        self.assertEqual(self.call("DELETE", "/api/pair", token=token)[0], 200)
        self.assertEqual(self.call("GET", "/api/library", token=token)[0], 401)

    # ---------------------------------------------------------------- library
    def test_library_lists_series_volumes_and_panel_states(self):
        lib = self.library(self.pair())
        by_title = {s["title"]: s for s in lib["series"]}
        self.assertEqual(set(by_title), {"Berserk", "Loose files"})
        berserk = {v["file"]: v for v in by_title["Berserk"]["volumes"]}
        self.assertEqual(berserk["Berserk v01.cbz"]["panels"], "none")
        self.assertEqual(berserk["Berserk v02.cbz"]["panels"], "ready")
        self.assertEqual(by_title["Loose files"]["volumes"][0]["panels"], "old")
        self.assertEqual(berserk["Berserk v01.cbz"]["id"], volume_id("Berserk/Berserk v01.cbz"))

    def test_unchanged_library_is_cheap(self):
        token = self.pair()
        gen = self.library(token)["generation"]
        self.assertEqual(self.js("GET", f"/api/library?since={gen}", token=token)[1], {"generation": gen, "unchanged": True})

    def test_files_still_being_copied_are_not_offered(self):
        token = self.pair()
        make_cbz(self.lib / "Berserk" / "Berserk v09.cbz")  # brand new mtime
        self.hub.library.scan()
        self.assertIsNone(self.vol(token, "Berserk v09.cbz"))
        self.assertIn("Berserk/Berserk v09.cbz", self.hub.library.summary()["pending"])

    # ---------------------------------------------------------------- downloads
    def test_download_whole_file(self):
        token = self.pair()
        v = self.vol(token, "Berserk v01.cbz")
        self.assertEqual(self.js("GET", f"/api/volume/{v['id']}", token=token)[1]["size"], len(self.v01))
        status, headers, body = self.call("GET", f"/api/file/{v['id']}?v={v['version']}", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(body, self.v01)
        self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_download_ranges(self):
        token = self.pair()
        v = self.vol(token, "Berserk v01.cbz")
        url = f"/api/file/{v['id']}"
        status, headers, body = self.call("GET", url, token=token, headers={"Range": "bytes=10-19"})
        self.assertEqual((status, body), (206, self.v01[10:20]))
        self.assertEqual(headers["Content-Range"], f"bytes 10-19/{len(self.v01)}")
        status, _, body = self.call("GET", url, token=token, headers={"Range": "bytes=100-"})
        self.assertEqual((status, body), (206, self.v01[100:]))
        status, _, body = self.call("GET", url, token=token, headers={"Range": "bytes=-5"})
        self.assertEqual((status, body), (206, self.v01[-5:]))
        self.assertEqual(self.call("GET", url, token=token, headers={"Range": f"bytes={len(self.v01)}-"})[0], 416)

    def test_changed_version_is_refused(self):
        token = self.pair()
        v = self.vol(token, "Berserk v01.cbz")
        self.assertEqual(self.call("GET", f"/api/file/{v['id']}?v=1-1", token=token)[0], 412)

    def test_busy_file_answers_503(self):
        token = self.pair()
        v = self.vol(token, "Berserk v01.cbz")
        path = self.lib / "Berserk" / "Berserk v01.cbz"
        self.hub.gate.replacing[FileGate._key(path)] = 1
        try:
            status, headers, _ = self.call("GET", f"/api/file/{v['id']}", token=token)
            self.assertEqual((status, headers.get("Retry-After")), (503, "5"))
        finally:
            self.hub.gate.replacing.clear()

    # ---------------------------------------------------------------- uploads
    def upload(self, token, folder, name, data, size=None):
        q = urllib.parse.urlencode({"folder": folder, "file": name, "size": len(data) if size is None else size})
        return self.js("PUT", f"/api/upload?{q}", token=token, raw=data, headers={"Content-Type": "application/octet-stream"})

    def test_upload_stores_the_volume_and_offers_it_at_once(self):
        token = self.pair()
        data = make_cbz(Path(self.tmp.name) / "new.cbz", pages=5)
        status, res = self.upload(token, "Vagabond", "Vagabond v01.cbz", data)
        self.assertEqual((status, res["status"]), (201, "stored"))
        self.assertEqual((self.lib / "Vagabond" / "Vagabond v01.cbz").read_bytes(), data)
        self.hub.library.scan()
        self.assertIsNotNone(self.vol(token, "Vagabond v01.cbz"))
        self.assertFalse(any(p.name.endswith(".part") for p in self.lib.rglob("*")))

    def test_upload_of_a_file_the_pc_already_has(self):
        token = self.pair()
        status, res = self.upload(token, "Berserk", "Berserk v01.cbz", self.v01)
        self.assertEqual((status, res["status"]), (200, "exists"))

    def test_upload_rejects_unsafe_names_and_non_zips(self):
        token = self.pair()
        data = make_cbz(Path(self.tmp.name) / "x.cbz")
        for folder, name in (("..", "x.cbz"), ("a/b", "x.cbz"), ("", "..\\x.cbz"), ("S", "x.exe"), ("S", ".hidden.cbz")):
            self.assertEqual(self.upload(token, folder, name, data)[0], 400, (folder, name))
        status, res = self.upload(token, "S", "junk.cbz", b"not a zip at all" * 10)
        self.assertEqual((status, res["error"]), (422, "not_a_zip"))
        self.assertFalse((self.lib / "S" / "junk.cbz").exists())
        self.assertEqual(self.upload(token, "S", "y.cbz", data, size=len(data) + 1)[0], 400)

    # ---------------------------------------------------------------- this PC only
    def test_admin_needs_the_key_and_a_local_host_header(self):
        self.assertEqual(self.call("GET", "/admin/status")[0], 403)
        key = {"X-Admin-Key": self.hub.admin_key}
        self.assertEqual(self.call("GET", "/admin/status", headers={**key, "Host": "evil.example"})[0], 403)
        status, _, body = self.call("GET", "/admin/status", headers=key)
        self.assertEqual(status, 200)
        self.assertIn("code", json.loads(body))

    def test_qr_link_carries_the_tailscale_address_when_there_is_one(self):
        self.assertNotIn("t=", self.hub.pair_url())
        self.hub._tailscale = ["100.101.102.103"]
        self.assertIn("t=100.101.102.103", self.hub.pair_url())
        key = {"X-Admin-Key": self.hub.admin_key}
        self.assertEqual(json.loads(self.call("GET", "/admin/status", headers=key)[2])["tailscale"], ["100.101.102.103"])

    def test_status_page_carries_the_admin_key(self):
        status, _, body = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(self.hub.admin_key.encode(), body)


class PiecesTest(unittest.TestCase):
    def test_safe_name(self):
        for ok in ("Berserk", "Berserk v01 (2003).cbz", "ワンピース"):
            self.assertTrue(safe_name(ok), ok)
        for bad in ("", ".", "..", "a/b", "a\\b", "x:y", ".hidden", "trailing.", " lead", "a" * 300):
            self.assertFalse(safe_name(bad), bad)

    def test_allowed_clients(self):
        for ip in ("192.168.1.20", "10.0.0.2", "172.16.8.10", "127.0.0.1", "100.101.102.103", "169.254.1.1"):
            self.assertTrue(allowed_client(ipaddress.ip_address(ip)), ip)
        for ip in ("8.8.8.8", "100.128.0.1", "1.1.1.1"):
            self.assertFalse(allowed_client(ipaddress.ip_address(ip)), ip)

    def test_add_panels_entry_keeps_pages_and_skips_a_changed_file(self):
        from mangarino_hub.panels import add_panels_entry, file_version

        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "v.cbz"
            make_cbz(f, panels={"pages": {}})
            with zipfile.ZipFile(f) as z:
                pages = {n: z.read(n) for n in z.namelist() if n.endswith(".jpg")}
            self.assertFalse(add_panels_entry(f, b"{}", "0-0", FileGate().replace))  # not that version
            self.assertEqual(read_panels_state(f), "old")
            self.assertTrue(add_panels_entry(f, b'{"bubbles": "m", "pages": {}}', file_version(f), FileGate().replace))
            with zipfile.ZipFile(f) as z:
                self.assertEqual({n: z.read(n) for n in z.namelist() if n.endswith(".jpg")}, pages)
                self.assertEqual(z.namelist().count("mangarino-panels.json"), 1)
            self.assertEqual(read_panels_state(f), "ready")
            self.assertEqual([p.name for p in Path(d).iterdir()], ["v.cbz"])  # no temp file left

    def test_external_panelizer_only_reads_the_volume(self):
        fake = '''import json, sys, time
from pathlib import Path
args = sys.argv[1:]
assert "--dry-run" in args and "--overwrite" in args, args
print("PROGRESS 1 3", flush=True)
time.sleep(1.5)
out = Path(args[args.index("--json-out") + 1])
(out / (Path(args[0]).stem + ".panels.json")).write_text(json.dumps({"bubbles": "test", "pages": {}}))
'''
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "Manga" / "Berserk").mkdir(parents=True)
            vol = d / "Manga" / "Berserk" / "Berserk v01.cbz"
            make_cbz(vol)
            old = time.time() - 3600
            os.utime(vol, (old, old))
            (d / "panelize.py").write_text(fake, encoding="utf-8")
            cfg = Config(d / "hub.json")
            cfg.update(library_root=str(d / "Manga"), port=0)
            hub = Hub(cfg, host="127.0.0.1", log=lambda *a: None, panels=False, cache=d / "cache")
            hub.library.scan()
            w = hub.panels
            w._ext = (Path(sys.executable), d / "panelize.py")
            (v,) = hub.library.volumes.values()
            t = threading.Thread(target=w._process_external, args=(v,))
            t.start()
            deadline = time.time() + 60
            while not (w.current and w.current.get("done")) and time.time() < deadline:
                time.sleep(0.05)
            self.assertFalse(hub.gate.busy(vol))  # mid-detection, devices can still download it
            with hub.gate.reading(vol):
                pass
            t.join(60)
            self.assertEqual(w.failed, {})
            hub.library.scan()
            self.assertEqual(read_panels_state(vol), "ready")

    def test_panelizer_folder_check(self):
        from mangarino_hub.panels import valid_panelizer

        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(valid_panelizer(Path(d)))
            (Path(d) / "panelize.py").write_text("")
            self.assertFalse(valid_panelizer(Path(d)))  # no .venv yet
            py = Path(d) / ".venv" / "Scripts" / "python.exe"
            py.parent.mkdir(parents=True)
            py.write_bytes(b"")
            self.assertTrue(valid_panelizer(Path(d)))

    def test_read_panels_state(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            make_cbz(d / "a.cbz")
            make_cbz(d / "b.cbz", panels={"pages": {}})
            make_cbz(d / "c.cbz", panels={"bubbles": "m", "pages": {}})
            (d / "d.cbz").write_bytes(b"nope")
            self.assertEqual([read_panels_state(d / f"{n}.cbz") for n in "abcd"], ["none", "old", "ready", "bad"])

    def test_gate_replace_waits_for_readers_and_blocks_new_ones(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            dst, src = d / "v.cbz", d / "new.tmp"
            dst.write_bytes(b"old")
            src.write_bytes(b"new")
            gate = FileGate()
            done = threading.Event()
            with gate.reading(dst):
                t = threading.Thread(target=lambda: (gate.replace(src, dst), done.set()))
                t.start()
                time.sleep(0.3)
                self.assertFalse(done.is_set())  # still waiting for our reader
                with self.assertRaises(Busy):
                    with gate.reading(dst):
                        pass
            t.join(5)
            self.assertTrue(done.is_set())
            self.assertEqual(dst.read_bytes(), b"new")


if __name__ == "__main__":
    unittest.main()
