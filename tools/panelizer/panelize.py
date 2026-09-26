#!/usr/bin/env python3
"""panelize.py - detect manga panels in CBZ/ZIP archives (or folders of images)
and store the result as a `mangarino-panels.json` entry for the Mangarino reader.

Panels: leoxs22/manga-panel-detector-yolo26n (Apache-2.0), a YOLO26-nano fine-tuned
on Manga109-s. Classes: 0 = panel ("frame"), 1 = text. Input size 640, recommended conf 0.25.

Speech bubbles: ogkalu/comic-text-and-bubble-detector (Apache-2.0), an RT-DETR-v2 model.
Classes: 0 = bubble (the whole balloon), 1 = text inside a bubble, 2 = text outside bubbles.
Panels grow to take in any balloon that spills over their border (--bubbles off skips it).

Usage:
    panelize.py <path> [<path> ...] [--overwrite] [--conf 0.25] [--imgsz 640]
                [--batch 16] [--device auto|cpu|0] [--ltr] [--bubbles on|off]
                [--dry-run] [--json-out DIR]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import time
import traceback
import warnings
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)  # torch/pynvml noise

from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

MODEL_REPO = "leoxs22/manga-panel-detector-yolo26n"
MODEL_FILE = "manga_panel_detector_fp32.pt"
MODEL_DIR = Path(__file__).resolve().parent / "models"
JSON_ENTRY = "mangarino-panels.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
ARCHIVE_EXTS = {".cbz", ".zip"}
PANEL_CLASS = 0
TEXT_CLASS = 1
MIN_AREA_FRAC = 0.01  # drop boxes smaller than 1% of the page
MERGE_IOU = 0.7  # merge boxes overlapping more than this (keep the union)
ROW_OVERLAP = 0.40  # vertical overlap (of the shorter box) needed to share a row
TEXT_ATTACH_MIN = 0.15  # a text box belongs to a panel when at least this much of it lies inside
TEXT_SPILL_FRAC = 0.005  # ...and it pokes out of that panel by more than this (of page width)
TEXT_SHARE_MIN = 0.30  # a panel beside it holding this much of a balloon grows over it too
GROWTH = 2  # the growth rules' revision, stored in the file: the hub redoes volumes made with older ones
TEXT_PAD_FRAC = 0.02  # text boxes hug the lettering; pad them (of page width) to take in the balloon
BUBBLE_REPO = "ogkalu/comic-text-and-bubble-detector"
BUBBLE_THRESHOLD = 0.3  # RT-DETR score cut-off
BUBBLE_PAD_FRAC = 0.005  # whole-balloon and container boxes already include the outline
COVERED_FRAC = 0.6  # text this much inside a detected balloon needs no container search
CONTAINER_LIGHT = 200  # grey level counted as paper when finding the box around some lettering
CONTAINER_MAX_MULT = 8.0  # a container's inside may be at most this many times the lettering's box


# --------------------------------------------------------------------------- helpers
def log(msg: str = "") -> None:
    print(msg, flush=True)


def is_page_entry(name: str) -> bool:
    """True for image entries we should detect on (skips macOS junk and thumbs)."""
    if name.endswith("/"):
        return False
    norm = name.replace("\\", "/")
    if norm.startswith("__MACOSX/") or "/__MACOSX/" in norm:
        return False
    base = norm.rsplit("/", 1)[-1]
    if base.startswith("._") or base.lower() == "thumbs.db":
        return False
    return Path(base).suffix.lower() in IMAGE_EXTS


def decode_image(data: bytes, imgsz: int) -> tuple[Image.Image, int, int]:
    """Decode image bytes -> (RGB PIL image, original width, original height).

    JPEGs are decoded with Pillow's DCT `draft` scaling so the decoded copy is still at
    least `imgsz` on both axes; that is 2-4x faster than a full-resolution decode for
    2560px pages and the model letterboxes to `imgsz` anyway. Boxes are mapped back to
    original coordinates by the caller using the returned original size.
    """
    im = Image.open(io.BytesIO(data))
    ow, oh = im.size
    try:
        im.draft("RGB", (imgsz, imgsz))  # no-op for non-JPEG
    except Exception:
        pass
    if im.mode != "RGB":
        im = im.convert("RGB")
    im.load()
    return im, ow, oh


# --------------------------------------------------------------------------- box math
def iou(a: list[float], b: list[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def merge_overlapping(boxes: list[list[float]], thr: float = MERGE_IOU) -> list[list[float]]:
    """Repeatedly union any pair with IoU > thr until stable."""
    boxes = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        out: list[list[float]] = []
        while boxes:
            cur = boxes.pop(0)
            i = 0
            while i < len(boxes):
                if iou(cur, boxes[i]) > thr:
                    o = boxes.pop(i)
                    cur = [min(cur[0], o[0]), min(cur[1], o[1]), max(cur[2], o[2]), max(cur[3], o[3])]
                    changed = True
                else:
                    i += 1
            out.append(cur)
        boxes = out
    return boxes


def share_row(a: list[float], b: list[float]) -> bool:
    overlap = min(a[3], b[3]) - max(a[1], b[1])
    shorter = min(a[3] - a[1], b[3] - b[1])
    return shorter > 0 and overlap >= ROW_OVERLAP * shorter


def share_col(a: list[float], b: list[float]) -> bool:
    overlap = min(a[2], b[2]) - max(a[0], b[0])
    narrower = min(a[2] - a[0], b[2] - b[0])
    return narrower > 0 and overlap >= ROW_OVERLAP * narrower


def _cluster(boxes: list[list[float]], same, key) -> list[list[list[float]]]:
    """Greedy transitive clustering: a box joins the first group containing any box
    it `same`s with; groups are then sorted by `key`."""
    groups: list[list[list[float]]] = []
    for b in boxes:
        for g in groups:
            if any(same(b, o) for o in g):
                g.append(b)
                break
        else:
            groups.append([b])
    groups.sort(key=key)
    return groups


def reading_order(boxes: list[list[float]], rtl: bool = True) -> list[list[float]]:
    """Manga reading order.

    1. Cluster boxes into rows: two boxes share a row when their vertical overlap is at least
       40% of the shorter box's height (transitively). Rows go top->bottom by top edge.
    2. Inside a row, order right->left by right edge (RTL) or left->right by left edge (LTR).
       If the row itself contains column groups (boxes sharing >=40% horizontal overlap of the
       narrower box, transitively), those groups are ordered by that same rule and each group
       is ordered recursively. That is what keeps a stack of small panels beside a tall panel
       in the right order instead of being flattened by the tall panel's row.
    """
    boxes = sorted(boxes, key=lambda r: (r[1], r[0]))
    if len(boxes) <= 1:
        return boxes
    rows = _cluster(boxes, share_row, key=lambda g: min(r[1] for r in g))
    if rtl:
        col_key = lambda g: (-max(r[2] for r in g), min(r[1] for r in g))  # noqa: E731
        box_key = lambda r: (-r[2], r[1])  # noqa: E731
    else:
        col_key = lambda g: (min(r[0] for r in g), min(r[1] for r in g))  # noqa: E731
        box_key = lambda r: (r[0], r[1])  # noqa: E731
    ordered: list[list[float]] = []
    for row in rows:
        if len(row) == 1:
            ordered.extend(row)
            continue
        cols = _cluster(sorted(row, key=box_key), share_col, key=col_key)
        if len(cols) == 1 and len(rows) == 1:
            ordered.extend(sorted(row, key=box_key))  # nothing left to split
            continue
        for col in cols:
            if len(col) == 1 or len(col) == len(boxes):
                ordered.extend(sorted(col, key=box_key))
            else:
                ordered.extend(reading_order(col, rtl))
    return ordered


def attach_boxes(panels: list[list[float]], items: list[tuple[list[float], float]], w: int, h: int) -> list[list[float]]:
    """Grow each panel over the balloons and captions that spill over its border.

    `items` are (box, pad) pairs in page pixels, the pad being a fraction of the page width.
    Every box is given to the panel holding the largest share of it (at least
    TEXT_ATTACH_MIN of the box's area), and also to any panel beside that one (sharing its row)
    holding at least TEXT_SHARE_MIN: a balloon across the gutter between two panels side by
    side is then whole in both. Between stacked panels it stays with the one holding most of
    it, because growing both would merge their rows and upset the reading order. If the box
    pokes out of a panel it's given to by more than TEXT_SPILL_FRAC of the page width, the
    panel becomes the union with the padded box. Boxes wholly inside their panel, or outside
    every panel, change nothing. Growth is measured against the original panels, so one
    expansion never pulls in another panel's balloons.
    """
    if not panels or not items:
        return panels
    out = [list(p) for p in panels]
    spill = TEXT_SPILL_FRAC * w
    for t, pad_frac in items:
        area = (t[2] - t[0]) * (t[3] - t[1])
        if area <= 0:
            continue
        shares = []
        for i, p in enumerate(panels):
            iw = min(t[2], p[2]) - max(t[0], p[0])
            ih = min(t[3], p[3]) - max(t[1], p[1])
            if iw > 0 and ih > 0:
                shares.append((iw * ih / area, i))
        if not shares:
            continue
        best_frac, best = max(shares)
        if best_frac < TEXT_ATTACH_MIN:
            continue
        pad = pad_frac * w
        for frac, i in shares:
            if i != best and (frac < TEXT_SHARE_MIN or not share_row(panels[best], panels[i])):
                continue
            p = panels[i]
            if t[0] >= p[0] - spill and t[1] >= p[1] - spill and t[2] <= p[2] + spill and t[3] <= p[3] + spill:
                continue
            o = out[i]
            o[0] = max(0.0, min(o[0], t[0] - pad))
            o[1] = max(0.0, min(o[1], t[1] - pad))
            o[2] = min(float(w), max(o[2], t[2] + pad))
            o[3] = min(float(h), max(o[3], t[3] + pad))
    return out


def attach_text(panels: list[list[float]], texts: list[list[float]], w: int, h: int) -> list[list[float]]:
    """Lettering-only growth (--bubbles off): pad each text box to take in its balloon."""
    return attach_boxes(panels, [(t, TEXT_PAD_FRAC) for t in texts], w, h)


def light_components(im: Image.Image):
    """Connected regions of paper-coloured pixels (4-connected), as (labels, stats) from
    OpenCV. A balloon or caption box is one such region, walled in by its outline."""
    import cv2
    import numpy as np

    grey = np.asarray(im.convert("L"))
    mask = (grey >= CONTAINER_LIGHT).astype(np.uint8)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
    return labels, stats


def find_container(labels, stats, box: list[float]) -> list[float] | None:
    """The balloon or caption box around the lettering in `box` (image pixels), or None.

    The paper between the letters belongs to the region inside the container's outline, so
    the region covering most of the lettering is the container, whatever its shape: round,
    square or jagged. It is rejected when it touches the image edge, or when its inside
    (pixels, not bounding box, so round and spiky balloons are not penalised) is more than
    CONTAINER_MAX_MULT times the lettering's box: it leaked into open background. It is also
    rejected when it does not enclose most of the lettering (light text on a dark box).
    """
    import numpy as np

    H, W = labels.shape
    x1, y1 = max(0, int(round(box[0]))), max(0, int(round(box[1])))
    x2, y2 = min(W, int(round(box[2]))), min(H, int(round(box[3])))
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None
    win = labels[y1:y2, x1:x2]
    ids, counts = np.unique(win[win > 0], return_counts=True)
    if len(ids) == 0:
        return None
    lab = int(ids[np.argmax(counts)])
    bx, by, bw, bh, inside = (int(v) for v in stats[lab][:5])
    if bx <= 0 or by <= 0 or bx + bw >= W or by + bh >= H:
        return None
    text_area = (x2 - x1) * (y2 - y1)
    if inside > CONTAINER_MAX_MULT * text_area:
        return None
    iw = min(x2, bx + bw) - max(x1, bx)
    ih = min(y2, by + bh) - max(y1, by)
    if iw <= 0 or ih <= 0 or iw * ih < 0.8 * text_area:
        return None
    return [float(bx), float(by), float(bx + bw), float(by + bh)]


def _covered(t: list[float], balloons: list[list[float]]) -> bool:
    area = (t[2] - t[0]) * (t[3] - t[1])
    for b in balloons:
        iw = min(t[2], b[2]) - max(t[0], b[0])
        ih = min(t[3], b[3]) - max(t[1], b[1])
        if iw > 0 and ih > 0 and iw * ih >= COVERED_FRAC * area:
            return True
    return False


def growth_items(texts, bubbles, image, sx: float, sy: float) -> list[tuple[list[float], float]]:
    """What panels should grow over, as (box in page pixels, pad fraction) pairs.

    - Whole balloons from the bubble model, padded slightly.
    - Lettering not inside a detected balloon (from either model): the container around it
      when one is found, else the lettering padded by TEXT_PAD_FRAC.
    - Loose text (outside bubbles) only when it sits in a closed box, like a narration
      caption. Bare loose text can be a sound effect drawn across panels, so it is skipped.
    `texts` are page pixels; `bubbles` are (name, box) in `image` pixels.
    """

    def page(b):
        return [b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy]

    balloons = [page(b) for n, b in bubbles if n == "bubble"]
    lettering = list(texts) + [page(b) for n, b in bubbles if n == "text_bubble"]
    loose = [page(b) for n, b in bubbles if n == "text_free"]
    items: list[tuple[list[float], float]] = [(b, BUBBLE_PAD_FRAC) for b in balloons]
    comps = None

    def container(t):
        nonlocal comps
        if comps is None:
            comps = light_components(image)
        c = find_container(*comps, [t[0] / sx, t[1] / sy, t[2] / sx, t[3] / sy])
        return None if c is None else page(c)

    for t in lettering:
        if _covered(t, balloons):
            continue
        c = container(t)
        items.append((c, BUBBLE_PAD_FRAC) if c else (t, TEXT_PAD_FRAC))
    for t in loose:
        if _covered(t, balloons):
            continue
        c = container(t)
        if c:
            items.append((c, BUBBLE_PAD_FRAC))
    return items


def postprocess(xyxy, cls, w: int, h: int, sx: float, sy: float, rtl: bool, bubbles=None, image=None) -> list[dict]:
    """Class split, scale to original pixels, clamp, area filter, merge, grow panels over
    spilling balloons, round, sort. Sorting runs on the final integer boxes so the app, which
    re-sorts them for the reader's direction, gets exactly this order back.

    `bubbles` is the bubble model's [(name, box)] for this page in decoded-image pixels, with
    `image` the decoded page. None means --bubbles off: lettering plus padding only."""
    boxes: list[list[float]] = []
    texts: list[list[float]] = []
    min_area = MIN_AREA_FRAC * w * h
    for (x1, y1, x2, y2), c in zip(xyxy, cls):
        if int(c) not in (PANEL_CLASS, TEXT_CLASS):
            continue
        x1, x2 = max(0.0, min(float(w), x1 * sx)), max(0.0, min(float(w), x2 * sx))
        y1, y2 = max(0.0, min(float(h), y1 * sy)), max(0.0, min(float(h), y2 * sy))
        if int(c) == TEXT_CLASS:
            texts.append([x1, y1, x2, y2])
            continue
        if (x2 - x1) * (y2 - y1) < min_area:
            continue
        boxes.append([x1, y1, x2, y2])
    boxes = merge_overlapping(boxes)
    boxes = [b for b in boxes if (b[2] - b[0]) * (b[3] - b[1]) >= min_area]
    if bubbles is None:
        boxes = attach_text(boxes, texts, w, h)
    else:
        boxes = attach_boxes(boxes, growth_items(texts, bubbles, image, sx, sy), w, h)
    ints: list[list[float]] = []
    for x1, y1, x2, y2 in boxes:
        ix1, iy1 = int(round(x1)), int(round(y1))
        ix2, iy2 = int(round(x2)), int(round(y2))
        ix1, iy1 = max(0, min(w, ix1)), max(0, min(h, iy1))
        ix2, iy2 = max(0, min(w, ix2)), max(0, min(h, iy2))
        if ix2 - ix1 < 1 or iy2 - iy1 < 1:
            continue
        ints.append([ix1, iy1, ix2, iy2])
    return [{"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1} for x1, y1, x2, y2 in reading_order(ints, rtl)]


# --------------------------------------------------------------------------- model
class Detector:
    def __init__(self, device: str, conf: float, imgsz: int, batch: int):
        import torch
        from ultralytics import YOLO

        try:  # ultralytics sends usage analytics unless told not to; keep everything on this PC
            from ultralytics.utils import SETTINGS

            SETTINGS.update({"sync": False})
        except Exception:  # noqa: BLE001
            pass
        self.conf, self.imgsz, self.batch = conf, imgsz, max(1, batch)
        self.model_path = ensure_model()
        self.model = YOLO(str(self.model_path))
        if device == "auto":
            device = "0" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.cuda = device != "cpu"
        self.torch = torch
        self.precision_kw = self._precision_kw()
        if self.cuda:
            try:
                name = torch.cuda.get_device_name(int(device) if device.isdigit() else 0)
            except Exception:
                name = "cuda"
            log(f"device: cuda:{device} ({name}), fp16")
        else:
            log("device: cpu, fp32")
        self._warmup()

    def _precision_kw(self) -> dict:
        if not self.cuda:
            return {}
        try:
            from ultralytics.cfg import DEFAULT_CFG_DICT

            if "quantize" in DEFAULT_CFG_DICT:
                return {"quantize": 16}  # ultralytics >= 8.4: fp16
        except Exception:
            pass
        return {"half": True}

    def _warmup(self) -> None:
        blank = Image.new("RGB", (self.imgsz, self.imgsz), "white")
        try:
            self._predict([blank])
        except Exception as e:  # noqa: BLE001
            if self.cuda:
                log(f"WARNING: GPU warm-up failed ({type(e).__name__}: {e}); falling back to CPU")
                self._to_cpu()
                self._predict([blank])
            else:
                raise

    def _to_cpu(self) -> None:
        self.device, self.cuda, self.precision_kw = "cpu", False, {}

    def _predict(self, images: list[Image.Image]):
        return self.model.predict(
            images, imgsz=self.imgsz, conf=self.conf, device=self.device, verbose=False, **self.precision_kw
        )

    def predict(self, images: list[Image.Image]):
        try:
            return self._predict(images)
        except Exception as e:  # noqa: BLE001
            if not self.cuda:
                raise
            log(f"WARNING: GPU inference failed ({type(e).__name__}: {e}); retrying on CPU")
            self._to_cpu()
            return self._predict(images)


class BubbleDetector:
    """RT-DETR-v2 speech-bubble model (transformers). Returns, per image, (name, box) pairs in
    that image's pixels, name being "bubble", "text_bubble" or "text_free". Follows the panel
    detector's device, and falls back to CPU if the GPU fails."""

    def __init__(self, device: str, threshold: float = BUBBLE_THRESHOLD):
        import torch
        from transformers import RTDetrImageProcessor, RTDetrV2ForObjectDetection

        self.torch, self.threshold = torch, threshold
        cache = str(MODEL_DIR / "hf")
        self.proc = RTDetrImageProcessor.from_pretrained(BUBBLE_REPO, cache_dir=cache)
        self.model = RTDetrV2ForObjectDetection.from_pretrained(BUBBLE_REPO, cache_dir=cache, use_safetensors=True)
        self.model.eval()
        self.names = {int(k): v for k, v in self.model.config.id2label.items()}
        self.device = "cpu" if device == "cpu" else (f"cuda:{device}" if device.isdigit() else "cuda")
        self.model.to(self.device)
        log(f"bubbles: {BUBBLE_REPO} on {self.device}")

    def _predict(self, images: list[Image.Image]):
        torch = self.torch
        with torch.no_grad():
            inputs = self.proc(images=images, return_tensors="pt").to(self.device)
            out = self.model(**inputs)
            sizes = torch.tensor([(im.height, im.width) for im in images], device=self.device)
            res = self.proc.post_process_object_detection(out, target_sizes=sizes, threshold=self.threshold)
        return [
            [(self.names[int(lab)], box) for box, lab in zip(r["boxes"].tolist(), r["labels"].tolist())]
            for r in res
        ]

    def predict(self, images: list[Image.Image]):
        try:
            return self._predict(images)
        except Exception as e:  # noqa: BLE001
            if self.device == "cpu":
                raise
            log(f"WARNING: bubble model failed on GPU ({type(e).__name__}: {e}); retrying on CPU")
            self.device = "cpu"
            self.model.to("cpu")
            return self._predict(images)


def ensure_model() -> Path:
    path = MODEL_DIR / MODEL_FILE
    if path.is_file() and path.stat().st_size > 0:
        return path
    from huggingface_hub import hf_hub_download

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    log(f"downloading {MODEL_REPO}/{MODEL_FILE} -> {MODEL_DIR}")
    got = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE, local_dir=str(MODEL_DIR))
    return Path(got)


# --------------------------------------------------------------------------- jobs
class PageSource:
    """Abstracts 'pages inside a zip' vs 'loose images in a folder'."""

    def __init__(self, path: Path):
        self.path = path
        self.is_archive = path.is_file()
        self.label = path.name if self.is_archive else path.name + os.sep
        self.stem = path.stem if self.is_archive else path.name
        self.json_path = None if self.is_archive else path / JSON_ENTRY
        self._zip: zipfile.ZipFile | None = None
        if self.is_archive:
            self._zip = zipfile.ZipFile(path, "r")
            self.names = [i.filename for i in self._zip.infolist() if is_page_entry(i.filename)]
            self.has_json = JSON_ENTRY in self._zip.namelist()
        else:
            self.names = sorted(
                p.name for p in path.iterdir() if p.is_file() and is_page_entry(p.name)
            )
            self.has_json = self.json_path.is_file()

    def read(self, name: str) -> bytes:
        if self._zip is not None:
            return self._zip.read(name)
        return (self.path / name).read_bytes()

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()
            self._zip = None


def detect_pages(
    src: PageSource, det: Detector, rtl: bool, bub: BubbleDetector | None = None, on_progress=None
) -> dict:
    """Detect every page. `on_progress(done, total)` is called after each batch."""
    pages: dict[str, dict] = {}
    names = src.names
    imgsz, bs = det.imgsz, det.batch
    batches = [names[i : i + bs] for i in range(0, len(names), bs)]

    def decode_batch(batch_names: list[str]):
        out = []
        for n in batch_names:
            try:
                im, ow, oh = decode_image(src.read(n), imgsz)
                out.append((n, im, ow, oh, None))
            except Exception as e:  # noqa: BLE001
                out.append((n, None, 0, 0, f"{type(e).__name__}: {e}"))
        return out

    workers = max(2, min(8, (os.cpu_count() or 4)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(decode_batch, b) for b in batches]  # decode ahead of the GPU
        for fut in futures:
            decoded = fut.result()
            good = [d for d in decoded if d[1] is not None]
            for n, _, _, _, err in decoded:
                if err:
                    log(f"  WARNING: could not decode {n}: {err}")
                    pages[n] = {"w": 0, "h": 0, "panels": []}
            if not good:
                continue
            images = [d[1] for d in good]
            results = det.predict(images)
            bubbles = bub.predict(images) if bub is not None else [None] * len(good)
            for (n, im, ow, oh, _), res, bb in zip(good, results, bubbles):
                dw, dh = im.size
                sx, sy = ow / dw, oh / dh
                b = res.boxes
                xyxy = b.xyxy.cpu().numpy().tolist() if len(b) else []
                cls = b.cls.cpu().numpy().tolist() if len(b) else []
                panels = postprocess(xyxy, cls, ow, oh, sx, sy, rtl, bubbles=bb, image=im)
                pages[n] = {"w": ow, "h": oh, "panels": panels}
            if on_progress is not None:
                on_progress(len(pages), len(names))
    # keep archive order
    return {n: pages[n] for n in names if n in pages}


def build_json(pages: dict, conf: float, rtl: bool, bubbles: str | None = None) -> str:
    """`bubbles` names the bubble model used to grow panels, or None for lettering only."""
    doc = {
        "version": 1,
        "rtl": rtl,
        "text": True,
        "bubbles": bubbles,
        "growth": GROWTH,
        "model": MODEL_REPO,
        "conf": conf,
        "pages": pages,
    }
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"))


def rewrite_archive(path: Path, payload: bytes, overwrite: bool, replace=os.replace) -> None:
    """Copy every entry (same compression type, same comment) into a temp zip next to the
    original, add/replace the JSON entry, then atomically replace the original."""
    fd, tmp_name = tempfile.mkstemp(prefix=".panelize-", suffix=".tmp", dir=str(path.parent))
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        with zipfile.ZipFile(path, "r") as zin, zipfile.ZipFile(tmp, "w", allowZip64=True) as zout:
            zout.comment = zin.comment
            for info in zin.infolist():
                if info.filename == JSON_ENTRY:
                    if overwrite:
                        continue
                    raise RuntimeError(f"{JSON_ENTRY} already present (use --overwrite)")
                if info.is_dir():
                    zout.writestr(info, b"")
                    continue
                with zin.open(info, "r") as src, zout.open(info, "w") as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        dst.write(chunk)
            zi = zipfile.ZipInfo(JSON_ENTRY, date_time=datetime.now().timetuple()[:6])
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zout.writestr(zi, payload)
        replace(tmp, path)  # the hub passes a replace that waits for readers of `path`
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def collect_jobs(paths: list[str]) -> list[Path]:
    jobs: list[Path] = []
    seen: set[Path] = set()

    def add(p: Path) -> None:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            jobs.append(p)

    for raw in paths:
        p = Path(raw)
        if p.is_file():
            if p.suffix.lower() in ARCHIVE_EXTS:
                add(p)
            else:
                log(f"skip (not a .cbz/.zip): {p}")
        elif p.is_dir():
            for root, dirs, files in os.walk(p):
                dirs.sort()
                rootp = Path(root)
                if any(is_page_entry(f) for f in files):
                    add(rootp)  # loose image folder
                for f in sorted(files):
                    if Path(f).suffix.lower() in ARCHIVE_EXTS:
                        add(rootp / f)
        else:
            log(f"ERROR: path not found: {p}")
            jobs.append(p)  # reported as a failure below
    return jobs


def process(job: Path, det: Detector, args, bub: BubbleDetector | None = None) -> tuple[int, int, int, float]:
    """Returns (pages, pages_with_panels, panels, seconds)."""
    if not job.exists():
        raise FileNotFoundError(str(job))
    src = PageSource(job)
    try:
        if src.has_json and not args.overwrite:
            log(f"skip (has {JSON_ENTRY}; use --overwrite): {src.label}")
            return 0, 0, 0, 0.0
        if not src.names:
            log(f"skip (no image pages): {src.label}")
            return 0, 0, 0, 0.0
        t0 = time.perf_counter()
        on_progress = (lambda done, total: print(f"PROGRESS {done} {total}", flush=True)) if args.progress else None
        pages = detect_pages(src, det, rtl=not args.ltr, bub=bub, on_progress=on_progress)
        text = build_json(pages, args.conf, rtl=not args.ltr, bubbles=BUBBLE_REPO if bub else None)
        n_pages = len(pages)
        n_with = sum(1 for p in pages.values() if p["panels"])
        n_panels = sum(len(p["panels"]) for p in pages.values())
        secs = time.perf_counter() - t0
        ms = 1000.0 * secs / max(1, n_pages)
        log(
            f"{src.label}: {n_pages} pages, {n_with} with panels, {n_panels} panels, "
            f"{secs:.1f}s ({ms:.1f} ms/page)"
        )
    finally:
        src.close()

    if args.json_out:
        out_dir = Path(args.json_out)
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"{src.stem}.panels.json"
        out.write_text(text, encoding="utf-8")
        log(f"  wrote {out}")
    if args.dry_run:
        log("  dry-run: archive not modified")
        return n_pages, n_with, n_panels, secs
    tw = time.perf_counter()
    if src.is_archive:
        rewrite_archive(job, text.encode("utf-8"), args.overwrite)
        log(f"  wrote {JSON_ENTRY} into archive ({time.perf_counter() - tw:.1f}s)")
    else:
        src.json_path.write_text(text, encoding="utf-8")
        log(f"  wrote {src.json_path}")
    return n_pages, n_with, n_panels, secs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help=".cbz/.zip files, folders of archives, or folders of images")
    ap.add_argument("--overwrite", action="store_true", help=f"replace an existing {JSON_ENTRY}")
    ap.add_argument("--conf", type=float, default=0.25, help="confidence threshold (default 0.25)")
    ap.add_argument("--imgsz", type=int, default=640, help="model input size (default 640)")
    ap.add_argument("--batch", type=int, default=16, help="pages per inference batch (default 16)")
    ap.add_argument("--device", default="auto", help="auto | cpu | 0 (CUDA index)")
    ap.add_argument("--ltr", action="store_true", help="left-to-right reading order (default is manga RTL)")
    ap.add_argument(
        "--bubbles",
        choices=("on", "off"),
        default="on",
        help="grow panels over spilling speech bubbles with the bubble model (default on)",
    )
    ap.add_argument("--dry-run", action="store_true", help="detect and report, do not modify archives")
    ap.add_argument("--progress", action="store_true", help=argparse.SUPPRESS)  # machine-readable, for the hub
    ap.add_argument("--json-out", metavar="DIR", help="also write <stem>.panels.json into DIR")
    args = ap.parse_args(argv)

    jobs = collect_jobs(args.paths)
    if not jobs:
        log("nothing to do")
        return 1

    try:
        det = Detector(args.device, args.conf, args.imgsz, args.batch)
    except Exception as e:  # noqa: BLE001
        log(f"ERROR: could not load model: {type(e).__name__}: {e}")
        traceback.print_exc()
        return 2

    bub: BubbleDetector | None = None
    if args.bubbles == "on":
        try:
            bub = BubbleDetector(det.device)
        except Exception as e:  # noqa: BLE001
            log(f"WARNING: bubble model unavailable ({type(e).__name__}: {e}); growing panels over lettering only")

    tot_pages = tot_with = tot_panels = 0
    tot_secs = 0.0
    failures: list[tuple[Path, str]] = []
    done = 0
    for job in jobs:
        try:
            p, w, n, s = process(job, det, args, bub)
            if p:
                done += 1
            tot_pages += p
            tot_with += w
            tot_panels += n
            tot_secs += s
        except Exception as e:  # noqa: BLE001
            msg = f"{type(e).__name__}: {e}"
            log(f"ERROR: {job}: {msg}")
            failures.append((job, msg))

    log()
    ms = 1000.0 * tot_secs / tot_pages if tot_pages else 0.0
    log(
        f"TOTAL: {done} archive(s), {tot_pages} pages, {tot_with} with panels, {tot_panels} panels, "
        f"{tot_secs:.1f}s ({ms:.1f} ms/page), {len(failures)} failed"
    )
    for job, msg in failures:
        log(f"  FAILED {job}: {msg}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
