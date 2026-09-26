"""Cover thumbnails: the first page of a volume, shrunk to a small JPEG and kept in memory.

A full page is often 1 to 3 MB; a thumbnail is about 30 KB, so a device can show every cover
of a big library quickly. Without Pillow the first page is sent as it is.
"""
from __future__ import annotations

import io
import threading
from collections import OrderedDict

from .library import mime_of, page_bytes, volume_pages

THUMB_BOX = (360, 540)  # a 2:3 cover at about 3x a phone list thumbnail
MAX_ITEMS = 600


class Thumbs:
    def __init__(self, max_items: int = MAX_ITEMS):
        self.max_items = max_items
        self.lock = threading.Lock()
        self.cache: OrderedDict[tuple[str, str], tuple[bytes, str]] = OrderedDict()

    def cover(self, v) -> tuple[bytes, str]:
        """(image bytes, content type) for a volume's cover. Raises OSError, IndexError or
        zipfile.BadZipFile when the volume can't be read."""
        key = (v.id, v.version)
        with self.lock:
            hit = self.cache.get(key)
            if hit is not None:
                self.cache.move_to_end(key)
                return hit
        name = volume_pages(v)[0]["name"]
        raw = page_bytes(v, name)
        result = shrink(raw) or (raw, mime_of(name))
        with self.lock:
            self.cache[key] = result
            self.cache.move_to_end(key)
            while len(self.cache) > self.max_items:
                self.cache.popitem(last=False)
        return result


def shrink(raw: bytes) -> tuple[bytes, str] | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.draft("RGB", (THUMB_BOX[0] * 2, THUMB_BOX[1] * 2))  # JPEG: decode at a lower size, much faster
            im = im.convert("RGB")
            im.thumbnail(THUMB_BOX)
            out = io.BytesIO()
            im.save(out, "JPEG", quality=82, optimize=True, progressive=True)
            return out.getvalue(), "image/jpeg"
    except Exception:  # noqa: BLE001 - odd or damaged image: send the page as it is
        return None
