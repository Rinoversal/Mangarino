"""Approve-on-PC pairing, device covers, and one copy of the hub at a time.

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
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mangarino_hub import desktop, winutil  # noqa: E402
from mangarino_hub.app import Hub  # noqa: E402
from mangarino_hub.config import Config  # noqa: E402
from mangarino_hub.pairing import ASK_EVERY_S, DENIED_COOLDOWN_S, GUESSES_PER_IP, MAX_PENDING, REQUEST_TTL_S, Pairing  # noqa: E402

winutil.firewall_check = lambda port: {"allowRule": True, "blocked": 0, "profiles": []}
OLD = time.time() - 3600


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


class PairRequestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Config(Path(self.tmp.name) / "hub.json")
        self.clock = Clock()
        self.asked = []
        self.pairing = Pairing(self.config, clock=self.clock, on_request=self.asked.append)

    def tearDown(self):
        self.tmp.cleanup()

    def test_allow_hands_out_a_working_token_once(self):
        r = self.pairing.request("tab-1", "Tab S10", "192.168.1.30", "tablet")
        self.assertRegex(r["match"], r"^\d{4}$")
        self.assertEqual(self.asked[0]["deviceName"], "Tab S10")
        self.assertEqual(self.asked[0]["kind"], "tablet")
        self.assertEqual(self.pairing.wait(r["requestId"], 0), {"state": "pending"})
        self.assertTrue(self.pairing.decide(r["requestId"], True))
        res = self.pairing.wait(r["requestId"], 0)
        self.assertEqual(res["state"], "approved")
        device = self.pairing.device_for(res["token"])
        self.assertEqual((device["id"], device["name"], device["kind"]), ("tab-1", "Tab S10", "tablet"))
        self.assertEqual(self.pairing.wait(r["requestId"], 0), {"state": "expired"})  # only once
        self.assertEqual(self.pairing.pending(), [])

    def test_dont_allow_and_the_cooldown(self):
        r = self.pairing.request("tab-1", "Tab", "192.168.1.30")
        self.assertTrue(self.pairing.decide(r["requestId"], False))
        self.assertEqual(self.pairing.wait(r["requestId"], 0), {"state": "denied"})
        self.assertEqual(self.pairing.request("tab-1", "Tab", "192.168.1.30")["error"], "denied_recently")
        self.clock.t += DENIED_COOLDOWN_S + 1
        self.assertIn("requestId", self.pairing.request("tab-1", "Tab", "192.168.1.30"))
        self.assertEqual(self.config.devices, [])

    def test_asking_again_replaces_the_earlier_request(self):
        first = self.pairing.request("tab-1", "Tab", "192.168.1.30")
        self.assertEqual(self.pairing.request("tab-1", "Tab", "192.168.1.30")["error"], "too_soon")  # no popup spam
        self.clock.t += ASK_EVERY_S + 1
        second = self.pairing.request("tab-1", "Tab", "192.168.1.30")
        self.assertEqual([p["id"] for p in self.pairing.pending()], [second["requestId"]])
        self.assertFalse(self.pairing.decide(first["requestId"], True))

    def test_at_most_a_few_waiting_and_they_expire(self):
        for i in range(MAX_PENDING):
            self.assertIn("requestId", self.pairing.request(f"d{i}", "Phone", f"192.168.1.{40 + i}"))
        self.assertEqual(self.pairing.request("dx", "Phone", "192.168.1.99")["error"], "busy")
        self.clock.t += REQUEST_TTL_S + 1
        self.assertEqual(self.pairing.pending(), [])
        self.assertIn("requestId", self.pairing.request("dx", "Phone", "192.168.1.99"))

    def test_cancel_and_odd_names(self):
        r = self.pairing.request("", "  My\nPhone\t ", "192.168.1.30", "fridge")
        p = self.pairing.pending()[0]
        self.assertEqual((p["deviceName"], p["kind"]), ("My Phone", ""))
        self.pairing.cancel(r["requestId"])
        self.assertEqual(self.pairing.pending(), [])
        self.assertEqual(self.pairing.wait(r["requestId"], 0), {"state": "expired"})

    def test_code_guessing_is_paused_per_address(self):
        for _ in range(GUESSES_PER_IP):
            self.assertEqual(self.pairing.pair("000000" if self.pairing.code != "000000" else "111111", "x", "X", ip="192.168.1.66")["error"] in ("bad_code", "code_changed"), True)
        res = self.pairing.pair(self.pairing.current_code(), "x", "X", ip="192.168.1.66")
        self.assertEqual(res["error"], "too_many_tries")  # even the right code waits
        self.assertIn("token", self.pairing.pair(self.pairing.current_code(), "y", "Y", ip="192.168.1.67"))  # others unaffected
        self.clock.t += 601
        self.assertIn("token", self.pairing.pair(self.pairing.current_code(), "x", "X", ip="192.168.1.66"))

    def test_waiting_device_hears_the_answer_straight_away(self):
        pairing = Pairing(self.config)  # real clock: wait() really waits
        r = pairing.request("tab-1", "Tab", "192.168.1.30")
        threading.Timer(0.3, lambda: pairing.decide(r["requestId"], True)).start()
        start = time.time()
        res = pairing.wait(r["requestId"], 10)
        self.assertEqual(res["state"], "approved")
        self.assertLess(time.time() - start, 3)


class ServerPairingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        lib = base / "Manga" / "Berserk"
        lib.mkdir(parents=True)
        self.page = _jpeg(1200, 1800)
        with zipfile.ZipFile(lib / "Berserk v01.cbz", "w") as z:
            z.writestr("001.jpg", self.page)
            z.writestr("002.jpg", self.page)
        for p in (base / "Manga").rglob("*"):
            os.utime(p, (OLD, OLD))
        cfg = Config(base / "hub.json")
        cfg.update(library_root=str(base / "Manga"), port=0)
        self.hub = Hub(cfg, host="127.0.0.1", log=lambda *a: None, panels=False, cache=base / "cache")
        self.hub.start()
        self.base = f"http://127.0.0.1:{self.hub.port}"
        self.key = {"X-Admin-Key": self.hub.admin_key}

    def tearDown(self):
        self.hub.shutdown()
        self.tmp.cleanup()

    def call(self, path, body=None, method=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_device_asks_pc_allows_device_is_paired(self):
        hello = json.loads(self.call("/api/hello")[2])
        self.assertIn("approve", hello["features"])
        self.assertIn("build", hello)
        status, _, body = self.call("/api/pair-request", {"deviceId": "tab", "deviceName": "Tab S10", "deviceKind": "tablet"}, "POST")
        self.assertEqual(status, 202)
        ask = json.loads(body)
        self.assertEqual(ask["serverId"], self.hub.config.server_id)
        shown = json.loads(self.call("/admin/status", headers=self.key)[2])["pairRequests"]
        self.assertEqual([(r["deviceName"], r["match"]) for r in shown], [("Tab S10", ask["match"])])
        self.assertEqual(json.loads(self.call(f"/api/pair-request/{ask['requestId']}")[2])["state"], "pending")
        # The device waits; the PC answers meanwhile.
        threading.Timer(0.3, lambda: self.call("/admin/pair-request", {"id": ask["requestId"], "allow": True}, "POST", self.key)).start()
        res = json.loads(self.call(f"/api/pair-request/{ask['requestId']}?wait=10")[2])
        self.assertEqual(res["state"], "approved")
        self.assertEqual(res["name"], self.hub.config.name)
        auth = {"Authorization": f"Bearer {res['token']}"}
        self.assertEqual(self.call("/api/library", headers=auth)[0], 200)
        devices = json.loads(self.call("/admin/status", headers=self.key)[2])["devices"]
        self.assertEqual([(d["name"], d["kind"]) for d in devices], [("Tab S10", "tablet")])

    def test_answers_for_gone_requests_and_the_admin_key(self):
        ask = json.loads(self.call("/api/pair-request", {"deviceId": "tab", "deviceName": "Tab"}, "POST")[2])
        self.assertEqual(self.call("/admin/pair-request", {"id": ask["requestId"], "allow": True}, "POST")[0], 403)
        self.assertEqual(self.call(f"/api/pair-request/{ask['requestId']}", method="DELETE")[0], 200)
        self.assertEqual(self.call("/admin/pair-request", {"id": ask["requestId"], "allow": True}, "POST", self.key)[0], 410)
        self.assertEqual(json.loads(self.call(f"/api/pair-request/{ask['requestId']}")[2])["state"], "expired")

    def test_covers_are_small_and_need_a_token(self):
        pair = {"code": self.hub.pairing.current_code(), "deviceId": "tab", "deviceName": "Tab"}
        token = json.loads(self.call("/api/pair", pair, "POST")[2])["token"]
        vol = json.loads(self.call("/admin/library", headers=self.key)[2])["series"][0]["volumes"][0]
        self.assertEqual(self.call(f"/api/cover/{vol['id']}")[0], 401)
        status, headers, body = self.call(f"/api/cover/{vol['id']}", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual((status, headers["Content-Type"]), (200, "image/jpeg"))
        self.assertLess(len(body), len(self.page))
        self.assertEqual(self.call(f"/admin/cover/{vol['id']}?k={self.hub.admin_key}")[2], body)

    def test_show_without_a_window(self):
        self.assertEqual(json.loads(self.call("/admin/show", {}, "POST", self.key)[2]), {"ok": False})


class OneCopyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        (base / "Manga").mkdir()
        cfg = Config(base / "hub.json")
        cfg.update(library_root=str(base / "Manga"), port=0)
        self.hub = Hub(cfg, host="127.0.0.1", log=lambda *a: None, panels=False, cache=base / "cache")
        self.hub.start()
        self.instance = desktop.instance_file(cfg.path)
        self.opened = []
        self._open = desktop.webbrowser.open
        desktop.webbrowser.open = self.opened.append

    def tearDown(self):
        desktop.webbrowser.open = self._open
        if not self.hub._stop.is_set():
            self.hub.shutdown()
        self.tmp.cleanup()

    def test_versions_compare_by_number_then_build(self):
        self.assertGreater(desktop.version_key("0.2.0", 5), desktop.version_key("0.2.0", 0))
        self.assertGreater(desktop.version_key("0.10.0"), desktop.version_key("0.9.9", 99))
        self.assertEqual(desktop.version_key("0.2.0"), desktop.version_key("0.2.0", 0))

    def test_the_instance_file_belongs_to_this_process(self):
        desktop.write_instance(self.instance, self.hub.port, self.hub.admin_key)
        self.assertEqual(json.loads(self.instance.read_text())["key"], self.hub.admin_key)
        desktop.clear_instance(self.instance)
        self.assertFalse(self.instance.exists())
        self.instance.write_text(json.dumps({"pid": -5}))
        desktop.clear_instance(self.instance)  # someone else's: left alone
        self.assertTrue(self.instance.exists())

    def test_starting_again_shows_the_running_hub(self):
        # No instance file: the key comes from the running hub's own page, like older hubs.
        self.assertEqual(desktop._admin_key(self.hub.port, self.instance), self.hub.admin_key)
        self.assertEqual(desktop.hand_over(self.hub.port, self.instance, lambda *a: None), "shown")
        self.assertEqual(self.opened, [f"http://127.0.0.1:{self.hub.port}/"])  # it has no window of its own
        self.assertFalse(self.hub._stop.is_set())

    def test_a_newer_version_takes_over(self):
        waiter = threading.Thread(target=self.hub.wait, daemon=True)
        waiter.start()
        real = desktop.VERSION
        desktop.VERSION = "99.0.0"
        try:
            self.assertEqual(desktop.hand_over(self.hub.port, self.instance, lambda *a: None), "stopped")
        finally:
            desktop.VERSION = real
        waiter.join(5)
        self.assertTrue(self.hub._stop.is_set())
        self.assertIsNone(desktop.running_hub(self.hub.port))

    def test_the_installer_can_stop_it(self):
        waiter = threading.Thread(target=self.hub.wait, daemon=True)
        waiter.start()
        desktop.write_instance(self.instance, self.hub.port, self.hub.admin_key)
        self.assertTrue(desktop.stop_running(1, self.instance))  # the port comes from the instance file
        waiter.join(5)
        self.assertTrue(self.hub._stop.is_set())
        self.assertTrue(desktop.stop_running(self.hub.port, self.instance))  # nothing running: fine

    def test_something_else_on_the_port(self):
        self.assertEqual(desktop.hand_over(1, self.instance, lambda *a: None), "foreign")


def _jpeg(w, h) -> bytes:
    try:
        from PIL import Image
    except ImportError:
        raise unittest.SkipTest("Pillow is needed for the cover test")
    import io

    out = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 90)).save(out, "JPEG", quality=95)
    return out.getvalue()


if __name__ == "__main__":
    unittest.main()
