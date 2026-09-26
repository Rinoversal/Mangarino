"""Live transfers, for the status page and to pause panelizing while a device is syncing."""
from __future__ import annotations

import itertools
import threading
import time


class Transfers:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.active: dict[int, dict] = {}
        self.recent: list[dict] = []
        self._ids = itertools.count(1)

    def start(self, kind: str, name: str, total: int, device: str = "") -> int:
        tid = next(self._ids)
        with self.lock:
            self.active[tid] = {
                "id": tid, "kind": kind, "name": name, "device": device,
                "bytes": 0, "total": total, "started": self.clock(),
            }
        return tid

    def progress(self, tid: int, nbytes: int) -> None:
        with self.lock:
            t = self.active.get(tid)
            if t:
                t["bytes"] += nbytes

    def finish(self, tid: int, ok: bool, error: str | None = None) -> None:
        with self.lock:
            t = self.active.pop(tid, None)
            if t:
                t.update(ok=ok, error=error, ended=self.clock())
                self.recent = ([t] + self.recent)[:10]

    def any_active(self) -> bool:
        with self.lock:
            return bool(self.active)

    def snapshot(self) -> dict:
        now = self.clock()
        with self.lock:
            active = []
            for t in self.active.values():
                secs = max(0.001, now - t["started"])
                active.append({**{k: t[k] for k in ("id", "kind", "name", "device", "bytes", "total")}, "bps": t["bytes"] / secs})
            recent = [{k: t.get(k) for k in ("id", "kind", "name", "device", "bytes", "total", "ok", "error")} for t in self.recent]
        return {"active": active, "recent": recent}
