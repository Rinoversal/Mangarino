"""Coordinates readers and the panelizer's rewrite of the same file.

Windows can't replace a file that another handle has open, and a device mid-download must
never see its file swapped underneath it. Downloads register as readers; a replace waits for
them to finish while new readers get "busy" (the server answers 503 with Retry-After).
"""
from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path


class Busy(Exception):
    """The file is being replaced right now; try again shortly."""


class FileGate:
    def __init__(self):
        self.cv = threading.Condition()
        self.readers: dict[str, int] = {}
        self.replacing: dict[str, int] = {}  # path -> holders (a count, so holds can overlap)

    def _release(self, k: str) -> None:
        n = self.replacing.get(k, 0) - 1
        if n > 0:
            self.replacing[k] = n
        else:
            self.replacing.pop(k, None)

    @staticmethod
    def _key(path) -> str:
        return os.path.normcase(os.path.abspath(str(path)))

    @contextmanager
    def reading(self, path):
        k = self._key(path)
        with self.cv:
            if k in self.replacing:
                raise Busy(str(path))
            self.readers[k] = self.readers.get(k, 0) + 1
        try:
            yield
        finally:
            with self.cv:
                self.readers[k] -= 1
                if self.readers[k] <= 0:
                    del self.readers[k]
                self.cv.notify_all()

    def replace(self, src, dst, timeout: float = 300.0) -> None:
        """os.replace(src, dst) once no one is reading dst. Retries briefly when Windows still
        reports the file in use (an antivirus scan or the hub's own zip check)."""
        k = self._key(dst)
        with self.cv:
            self.replacing[k] = self.replacing.get(k, 0) + 1
            try:
                deadline = time.monotonic() + timeout
                while self.readers.get(k, 0) > 0:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise TimeoutError(f"{dst} is still being sent to a device")
                    self.cv.wait(min(left, 1.0))
                for attempt in range(20):
                    try:
                        os.replace(src, dst)
                        return
                    except PermissionError:
                        if attempt == 19:
                            raise
                        self.cv.wait(0.5)
            finally:
                self._release(k)
                self.cv.notify_all()

    def busy(self, path) -> bool:
        with self.cv:
            return self._key(path) in self.replacing


def is_inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False
