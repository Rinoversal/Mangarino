# panelizer

PC companion tool for Mangarino. Detects manga panels on every page of a CBZ/ZIP and stores
them inside the archive as `mangarino-panels.json`, so the reader can do panel-by-panel
navigation without running a model on the tablet.

## Requirements

Python 3.11 with `ultralytics`, `torch` (CUDA build for GPU), `transformers`, `pillow`,
`huggingface_hub`, `numpy` (see `requirements.txt`). On first run the two models are downloaded
from Hugging Face into `models/` and reused afterwards: the panel detector (~15 MB) and the
speech-bubble detector (~170 MB).

## Usage

```powershell
python D:\Mangarino\tools\panelizer\panelize.py <path> [<path> ...] [options]
```

`<path>` can be:
- a `.cbz` / `.zip` file
- a folder: every `.cbz` / `.zip` inside it is processed (recursively)
- a folder of loose images: `mangarino-panels.json` is written next to the images

Options:

| flag | default | meaning |
|---|---|---|
| `--overwrite` | off | replace an existing `mangarino-panels.json` (otherwise the archive is skipped) |
| `--conf 0.25` | 0.25 | detection confidence threshold |
| `--imgsz 640` | 640 | model input size |
| `--batch 16` | 16 | pages per inference batch |
| `--device auto\|cpu\|0` | auto | `auto` = CUDA if available, else CPU |
| `--ltr` | off | left-to-right reading order (default is manga right-to-left) |
| `--bubbles on\|off` | on | grow panels over speech bubbles found by the bubble model; `off` uses only the panel model's lettering boxes |
| `--dry-run` | off | detect and print the summary, never touch the archive (`--json-out` still writes) |
| `--json-out DIR` | - | also write `<archive stem>.panels.json` into DIR |

Examples:

```powershell
python tools\panelizer\panelize.py "D:\Manga\Berserk"
python tools\panelizer\panelize.py "D:\Manga\Vol 01.cbz" --overwrite --json-out D:\tmp
python tools\panelizer\panelize.py "D:\Manga\western-comic" --ltr --dry-run
```

Per archive it prints pages, pages with at least one panel, total panels, seconds and ms/page,
then a grand total. Exit code is non-zero if any archive failed; other archives still get processed.
On an RTX 5090 a 219-page volume of 1810x2560 JPEGs takes about 8 s to detect (~36 ms/page)
plus ~10 s to rewrite the 469 MB archive.

## How the archive is written

The original is never modified in place. Every entry is stream-copied into a temp zip in the
same folder (same compression type per entry, archive comment preserved), the JSON entry is added
with DEFLATE, and the temp file is `os.replace`d over the original. Page CRCs are unchanged.

## JSON format (`mangarino-panels.json`)

```json
{
  "version": 1,
  "rtl": true,
  "text": true,
  "bubbles": "ogkalu/comic-text-and-bubble-detector",
  "model": "leoxs22/manga-panel-detector-yolo26n",
  "conf": 0.25,
  "pages": {
    "Berserk - 001 (v01) - p003 [Digital-HD] [danke-Empire].jpg": {
      "w": 1810, "h": 2560,
      "panels": [ {"x": 12, "y": 30, "w": 800, "h": 1200}, ... ]
    }
  }
}
```

- Keys under `pages` are the entry names exactly as stored in the zip (or the file names for a
  loose folder). Every image entry (jpg/jpeg/png/webp/gif/avif) is present, with an empty
  `panels` list when nothing was detected. `__MACOSX/`, `._*` and `Thumbs.db` are ignored.
- Coordinates are integer pixels in the original image, clamped to the image bounds.
- `rtl` is `false` when the file was produced with `--ltr`.
- `text` is `true` when panels were grown over spilling speech bubbles. Files without it were
  written by an older panelizer; re-run with `--overwrite` to get the growth.
- `bubbles` names the bubble model used for that growth, or is `null` when the file was written
  with `--bubbles off` (or the bubble model could not load). Files without the key predate it.

## Post-processing and reading order

Per page: split the detections into panels (class 0) and text (class 1); drop panels smaller
than 1% of the page area; merge panels with IoU > 0.7 into their union.

Then grow panels over speech bubbles and captions that spill past their border. The boxes to
grow over come from three places:

- **Whole balloons** from the bubble model (class `bubble`), padded by 0.5% of the page width.
- **Lettering outside any detected balloon**, from either model. The tool looks for the container
  around it straight in the page image: the paper between the letters belongs to the region
  inside the balloon's or caption's outline, so that region's bounding box is the container,
  whatever its shape (round, square or jagged). The container is used, padded by 0.5%. When no
  container is found (the region touches the page edge, is more than 8 times the lettering's
  box, or doesn't enclose the lettering, as with white text on a black box), the lettering is
  used, padded by 2%.
- **Loose text** (class `text_free`) only when it sits in a closed container, like a narration
  caption. Bare loose text may be a sound effect drawn across panels, so it is skipped.

Each box goes to the panel holding the largest share of it, if that share is at least 15%. When
the box pokes out of that panel by more than 0.5% of the page width, the panel becomes its union
with the padded box. Boxes wholly inside a panel, or outside every panel, change nothing.
With `--bubbles off`, only the panel model's lettering boxes are used, padded by 2%.

Boxes are rounded to integer pixels and sorted into reading order. The app re-sorts them with
a port of the same code for the reader's current direction, so a manga-order file still reads
left to right in Western mode; `__tests__/panels.test.ts` checks the two against each other.

1. Cluster boxes into rows. Two boxes share a row when their vertical overlap is at least 40% of
   the shorter box's height (transitively).
2. Order rows top to bottom by their top edge.
3. Inside a row order right to left by the right edge (`x + w`, descending). With `--ltr`,
   left to right by `x` ascending.
4. If a row contains column groups (boxes whose horizontal overlap is at least 40% of the
   narrower box, transitively), the groups are ordered by rule 3 and each group is ordered
   recursively with rules 1-4. For a plain row of side-by-side panels this changes nothing.
   It matters when a tall panel sits next to a stack of small ones: the tall panel would
   otherwise pull the whole stack into its row and flatten it by right edge, which reads the
   stack in the wrong order.

## Performance notes

Pages are decoded from the zip in memory with Pillow in a thread pool ahead of the GPU. JPEGs use
Pillow's DCT `draft` scaling so a 2560px page is decoded at half size (still well above the 640px
model input); boxes are mapped back to full-resolution coordinates. On CUDA the model runs in
fp16 (`quantize=16`, or `half=True` on older ultralytics). If GPU inference fails the tool logs
the error and falls back to CPU automatically.

## Model credits

- Model: **Manga Panel and Text Detector (YOLO26-nano)** by Leandro Narosky,
  https://huggingface.co/leoxs22/manga-panel-detector-yolo26n (Apache-2.0).
  Classes: 0 = panel (named `frame`), 1 = text. Input 640x640, recommended conf 0.25.
- Model: **comic-text-and-bubble-detector** (RT-DETR-v2 r50vd) by ogkalu,
  https://huggingface.co/ogkalu/comic-text-and-bubble-detector (Apache-2.0).
  Classes: 0 = bubble, 1 = text inside a bubble, 2 = text outside bubbles. Input 640x640;
  the panelizer keeps detections scoring 0.3 or more.
- Training data: **Manga109-s** (Aizawa et al.), https://huggingface.co/datasets/hal-utokyo/Manga109-s.
  Per its license, results from machine-learning experiments may be used provided the dataset
  use is indicated, which this notice does.

```bibtex
@misc{leoxs22_manga_panel_detector_2026,
  author={Leandro Narosky},
  title={{Manga Panel and Text Detector (YOLO26-nano)}},
  year={2026}, publisher={Hugging Face},
  url={https://huggingface.co/leoxs22/manga-panel-detector-yolo26n}
}
@article{multimedia_aizawa_2020,
  author={Kiyoharu Aizawa and Azuma Fujimoto and Atsushi Otsubo and Toru Ogawa and Yusuke Matsui and Koki Tsubota and Hikaru Ikuta},
  title={Building a Manga Dataset ``Manga109'' with Annotations for Multimedia Applications},
  journal={IEEE MultiMedia}, volume={27}, number={2}, pages={8--18},
  doi={10.1109/mmul.2020.2987895}, year={2020}
}
@article{mtap_matsui_2017,
  author={Yusuke Matsui and Kota Ito and Yuji Aramaki and Azuma Fujimoto and Toru Ogawa and Toshihiko Yamasaki and Kiyoharu Aizawa},
  title={Sketch-based Manga Retrieval using Manga109 Dataset},
  journal={Multimedia Tools and Applications}, volume={76}, number={20}, pages={21811--21838},
  doi={10.1007/s11042-016-4020-z}, year={2017}
}
```
