"""Pairing a device with this PC. Either way, the device gets a long random token.

Approve on the PC (the usual way, like Bluetooth): the device asks, the PC shows
"<device> wants to connect" with a 4-digit match number that the device shows too, and
someone at the PC presses Allow.
- A request lasts 2 minutes. There are at most 4 waiting at once, and one per address.
- After "Don't allow", that address can't ask again for 30 seconds, so the PC isn't spammed.

A 6-digit code shown on the PC (for the QR code, and for typing it in):
- The code rotates after every successful pairing and every 10 minutes.
- After 5 wrong tries the code is thrown away and a new one is shown, so guessing needs
  someone who can read the PC screen.

Tokens are stored as SHA-256 hashes and compared in constant time.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time

from .config import Config

CODE_TTL_S = 600
MAX_TRIES = 5
REQUEST_TTL_S = 120
MAX_PENDING = 4
DENIED_COOLDOWN_S = 30
MAX_WAIT_S = 15
GUESS_WINDOW_S = 600
GUESSES_PER_IP = 5  # wrong codes from one address in 10 minutes, then it waits
GUESSES_TOTAL = 30  # wrong codes from everyone in 10 minutes, then code pairing pauses
ASK_EVERY_S = 10  # one pair request per address this often (each one brings the window up)
KINDS = ("phone", "tablet", "desktop", "tv")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class _Request:
    __slots__ = ("id", "device_id", "device_name", "kind", "ip", "match", "created", "state", "token")

    def __init__(self, device_id: str, device_name: str, kind: str, ip: str, now: float):
        self.id = secrets.token_urlsafe(18)  # only the asking device (and this PC's own page) knows it
        self.device_id = device_id
        self.device_name = device_name
        self.kind = kind
        self.ip = ip
        self.match = f"{secrets.randbelow(10**4):04d}"
        self.created = now
        self.state = "pending"  # pending | approved | denied
        self.token: str | None = None


class Pairing:
    def __init__(self, config: Config, clock=time.time, on_request=None):
        self.config, self.clock = config, clock
        self.on_request = on_request  # called with the request's public dict when a device asks
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.requests: dict[str, _Request] = {}
        self.denied_until: dict[str, float] = {}
        self.wrong: list[tuple[float, str]] = []  # (when, address) of wrong codes
        self.last_ask: dict[str, float] = {}
        self._new_code()

    # ------------------------------------------------------------------ the code
    def _new_code(self) -> None:
        self.code = f"{secrets.randbelow(10**6):06d}"
        self.issued = self.clock()
        self.tries = 0

    def new_code(self) -> None:
        with self.lock:
            self._new_code()

    def current_code(self) -> str:
        with self.lock:
            if self.clock() - self.issued > CODE_TTL_S:
                self._new_code()
            return self.code

    def pair(self, code: str, device_id: str, device_name: str, kind: str = "", ip: str = "") -> dict:
        """{"token": ...} on success, else {"error": "bad_code", "attemptsLeft": n}, or
        {"error": "too_many_tries", "retryAfterS": n} while guessing is paused."""
        code = "".join(ch for ch in str(code) if ch.isdigit())
        with self.lock:
            now = self.clock()
            self.wrong = [(t, a) for t, a in self.wrong if now - t < GUESS_WINDOW_S]
            mine = [t for t, a in self.wrong if a == ip]
            if len(mine) >= GUESSES_PER_IP or len(self.wrong) >= GUESSES_TOTAL:
                oldest = min(mine) if len(mine) >= GUESSES_PER_IP else min(t for t, _ in self.wrong)
                return {"error": "too_many_tries", "retryAfterS": int(GUESS_WINDOW_S - (now - oldest)) + 1}
            if now - self.issued > CODE_TTL_S:
                self._new_code()
            if not hmac.compare_digest(code.encode(), self.code.encode()):
                self.wrong.append((now, ip))
                self.tries += 1
                left = MAX_TRIES - self.tries
                if left <= 0:
                    self._new_code()
                    return {"error": "code_changed", "attemptsLeft": 0}
                return {"error": "bad_code", "attemptsLeft": left}
            token = self._register(device_id, device_name, kind)
            self._new_code()
            return {"token": token}

    def _register(self, device_id: str, device_name: str, kind: str = "") -> str:
        """Remember a device (replacing an older pairing of the same device); returns its token."""
        token = secrets.token_urlsafe(32)
        device = {
            "id": str(device_id)[:64] or secrets.token_hex(8),
            "name": str(device_name)[:80] or "Device",
            "kind": kind if kind in KINDS else "",
            "token_hash": _hash(token),
            "paired_ms": int(self.clock() * 1000),
        }
        with self.config.lock:
            devices = [d for d in self.config.devices if d.get("id") != device["id"]]
            devices.append(device)
            self.config.update(devices=devices)
        return token

    # ------------------------------------------------------------------ approve on the PC
    def _purge(self) -> None:
        now = self.clock()
        for rid in [r.id for r in self.requests.values() if now - r.created > REQUEST_TTL_S]:
            del self.requests[rid]
        for ip in [ip for ip, t in self.denied_until.items() if t <= now]:
            del self.denied_until[ip]

    @staticmethod
    def _public(r: _Request, now: float) -> dict:
        return {
            "id": r.id,
            "deviceName": r.device_name,
            "kind": r.kind,
            "ip": r.ip,
            "match": r.match,
            "ageMs": int((now - r.created) * 1000),
            "expiresMs": max(0, int((REQUEST_TTL_S - (now - r.created)) * 1000)),
        }

    def request(self, device_id: str, device_name: str, ip: str, kind: str = "") -> dict:
        """A device asks to pair. {"requestId", "match", "expiresMs"}, or {"error": ...}."""
        device_id = str(device_id)[:64]
        device_name = " ".join(str(device_name).split())[:80] or "A device"
        with self.lock:
            self._purge()
            now = self.clock()
            if ip in self.denied_until:
                return {"error": "denied_recently", "retryAfterS": int(self.denied_until[ip] - now) + 1}
            if now - self.last_ask.get(ip, float("-inf")) < ASK_EVERY_S:
                return {"error": "too_soon", "retryAfterS": int(ASK_EVERY_S - (now - self.last_ask[ip])) + 1}
            self.last_ask[ip] = now
            for a in [a for a, t in self.last_ask.items() if now - t > ASK_EVERY_S]:
                del self.last_ask[a]
            # One question per device: asking again replaces the earlier one.
            stale = [
                r.id for r in self.requests.values()
                if r.state == "pending" and (r.ip == ip or (device_id and r.device_id == device_id))
            ]
            for rid in stale:
                del self.requests[rid]
            if sum(1 for r in self.requests.values() if r.state == "pending") >= MAX_PENDING:
                return {"error": "busy"}
            r = _Request(device_id, device_name, kind if kind in KINDS else "", ip, now)
            self.requests[r.id] = r
            public = self._public(r, now)
            self.changed.notify_all()
        if self.on_request:
            try:
                self.on_request(public)
            except Exception:  # noqa: BLE001 - a window that can't pop up must not stop pairing
                pass
        return {"requestId": r.id, "match": r.match, "expiresMs": public["expiresMs"]}

    def wait(self, request_id: str, timeout: float = MAX_WAIT_S) -> dict:
        """The device's view of its request, waiting up to `timeout` seconds for an answer.
        An approved request hands out its token once, then is gone."""
        deadline = self.clock() + max(0.0, min(float(timeout), MAX_WAIT_S))
        with self.lock:
            while True:
                self._purge()
                r = self.requests.get(request_id)
                if r is None:
                    return {"state": "expired"}
                if r.state == "approved":
                    del self.requests[request_id]
                    return {"state": "approved", "token": r.token}
                if r.state == "denied":
                    del self.requests[request_id]
                    return {"state": "denied"}
                left = min(deadline, r.created + REQUEST_TTL_S) - self.clock()
                if left <= 0:
                    return {"state": "pending"}
                self.changed.wait(min(left, 1.0))

    def decide(self, request_id: str, allow: bool) -> bool:
        """This PC's answer. False when the request is gone (expired or withdrawn)."""
        with self.lock:
            self._purge()
            r = self.requests.get(request_id)
            if r is None or r.state != "pending":
                return False
            if allow:
                r.token = self._register(r.device_id or secrets.token_hex(8), r.device_name, r.kind)
                r.state = "approved"
            else:
                r.state = "denied"
                self.denied_until[r.ip] = self.clock() + DENIED_COOLDOWN_S
            self.changed.notify_all()
            return True

    def cancel(self, request_id: str) -> None:
        """The device stopped asking."""
        with self.lock:
            if self.requests.pop(request_id, None) is not None:
                self.changed.notify_all()

    def pending(self) -> list[dict]:
        with self.lock:
            self._purge()
            now = self.clock()
            waiting = sorted((r for r in self.requests.values() if r.state == "pending"), key=lambda r: r.created)
            return [self._public(r, now) for r in waiting]

    # ------------------------------------------------------------------ paired devices
    def device_for(self, token: str | None) -> dict | None:
        if not token:
            return None
        h = _hash(token)
        for d in list(self.config.devices):
            if hmac.compare_digest(h, d.get("token_hash", "")):
                return d
        return None

    def forget(self, device_id: str) -> bool:
        with self.config.lock:
            devices = [d for d in self.config.devices if d.get("id") != device_id]
            changed = len(devices) != len(self.config.devices)
            if changed:
                self.config.update(devices=devices)
            return changed
