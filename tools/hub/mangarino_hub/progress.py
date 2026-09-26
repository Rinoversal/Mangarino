"""Reading progress shared between the PC reader and every paired device.

One row per volume, keyed by "<series folder>/<file name>" (Unicode-normalised, lower case), the
same identity the app uses to match PC and device volumes. The newest change wins, by the time
the reader recorded it. Every accepted change gets a new revision number, so a device asks only
for what changed since the revision it last saw.
"""
from __future__ import annotations

import json
import os
import threading
import time
import unicodedata
from pathlib import Path

MAX_KEY = 400


FUTURE_SLACK_MS = 5 * 60 * 1000  # a device clock may run this far ahead


def progress_key(folder: str, file: str) -> str:
    return unicodedata.normalize("NFC", f"{folder}/{file}").lower()


def _clean(row: dict) -> dict | None:
    try:
        key = str(row["key"])
        page = int(row["page"])
        panel = row.get("panel")
        panel = None if panel is None else int(panel)
        completed = bool(row.get("completed", False))
        updated = int(row["updatedMs"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if not key or len(key) > MAX_KEY or page < 0 or (panel is not None and panel < 0) or updated <= 0:
        return None
    return {
        "key": unicodedata.normalize("NFC", key).lower(),
        "page": page,
        "panel": panel,
        "completed": completed,
        "updatedMs": updated,
    }


class ProgressStore:
    def __init__(self, path: Path, clock=time.time):
        self.path = path
        self.clock = clock
        self.lock = threading.Lock()
        self.rev = 0
        self.rows: dict[str, dict] = {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self.rev = int(data.get("rev", 0))
            self.rows = {r["key"]: r for r in data.get("rows", []) if isinstance(r, dict) and "key" in r}
        except (OSError, ValueError, TypeError):
            pass

    def _save(self) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps({"rev": self.rev, "rows": list(self.rows.values())}), encoding="utf-8")
        os.replace(tmp, self.path)

    def merge(self, rows: list) -> int:
        """Keep each incoming row that is newer than what's stored. Returns how many were kept."""
        accepted = 0
        with self.lock:
            for raw in rows if isinstance(rows, list) else []:
                row = _clean(raw) if isinstance(raw, dict) else None
                if row is None:
                    continue
                # A device clock set ahead must not freeze this volume's position everywhere.
                row["updatedMs"] = min(row["updatedMs"], int(self.clock() * 1000) + FUTURE_SLACK_MS)
                old = self.rows.get(row["key"])
                if old and old["updatedMs"] >= row["updatedMs"]:
                    continue
                self.rev += 1
                row["rev"] = self.rev
                self.rows[row["key"]] = row
                accepted += 1
            if accepted:
                self._save()
        return accepted

    def since(self, rev: int) -> dict:
        with self.lock:
            rows = [
                {k: r[k] for k in ("key", "page", "panel", "completed", "updatedMs")}
                for r in self.rows.values()
                if r.get("rev", 0) > rev
            ]
            return {"rev": self.rev, "rows": rows}

    def get(self, key: str) -> dict | None:
        with self.lock:
            r = self.rows.get(unicodedata.normalize("NFC", key).lower())
            return None if r is None else {k: r[k] for k in ("key", "page", "panel", "completed", "updatedMs")}
