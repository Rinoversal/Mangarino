"""Build inputs for the Windows app and its installer, written to build/ (git-ignored):

- version_info.txt: the .exe's version details, so Windows shows "Mangarino Hub" in Task Manager
  and in the file's properties (for PyInstaller --version-file)
- version.txt: the full version number, for the installer
- wizard.bmp, wizard-2x.bmp, wizard-small.bmp, wizard-small-2x.bmp: the installer's pictures

    python tools/hub/installer/prepare.py <build number>
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE.parent))

from mangarino_hub import VERSION, brand  # noqa: E402

NAVY = (8, 21, 59)
PINK = (255, 45, 149)


def version_info(numbers: tuple[int, int, int, int]) -> str:
    dotted = ".".join(map(str, numbers))
    name = brand.HUB
    return f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={numbers}, prodvers={numbers}, mask=0x3f, flags=0x0, OS=0x40004,
                    fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', '{brand.NAME}'),
      StringStruct('FileDescription', '{name}'),
      StringStruct('FileVersion', '{dotted}'),
      StringStruct('InternalName', '{name}'),
      StringStruct('OriginalFilename', '{name}.exe'),
      StringStruct('ProductName', '{name}'),
      StringStruct('ProductVersion', '{dotted}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"""


def picture(size: tuple[int, int], logo_frac: float, dots: bool):
    """Midnight blue, a fade of pink halftone dots (manga screentone) and the logo."""
    from PIL import Image, ImageDraw

    w, h = size
    img = Image.new("RGB", size, NAVY)
    if dots:
        d = ImageDraw.Draw(img)
        step = max(6, w // 26)
        for y in range(0, h + step, step):
            for x in range(0, w + step, step):
                # Stronger towards the bottom-left corner, gone by the middle.
                t = max(0.0, 1.0 - ((x / w) ** 2 + ((h - y) / h) ** 2) ** 0.5 / 0.95)
                r = step * 0.42 * t
                if r > 0.4:
                    c = tuple(int(NAVY[i] + (PINK[i] - NAVY[i]) * (0.25 + 0.35 * t)) for i in range(3))
                    d.ellipse((x - r, y - r, x + r, y + r), fill=c)
    logo = Image.open(HERE.parent / "web" / "logo.png").convert("RGBA")
    side = int(min(w, h) * logo_frac)
    logo = logo.resize((side, side), Image.LANCZOS)
    top = (h - side) // 2 if h < w * 1.2 else int(h * 0.22)
    img.paste(logo, ((w - side) // 2, top), logo)
    return img


def main() -> None:
    build = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    major, minor, patch = (int(x) for x in VERSION.split("."))
    numbers = (major, minor, patch, build)
    out = ROOT / "build"
    out.mkdir(exist_ok=True)
    (out / "version_info.txt").write_text(version_info(numbers), encoding="utf-8")
    (out / "version.txt").write_text(".".join(map(str, numbers)), encoding="ascii")
    picture((164, 314), 0.62, True).save(out / "wizard.bmp")
    picture((328, 628), 0.62, True).save(out / "wizard-2x.bmp")
    picture((55, 58), 0.9, False).save(out / "wizard-small.bmp")
    picture((110, 116), 0.9, False).save(out / "wizard-small-2x.bmp")
    print(".".join(map(str, numbers)))


if __name__ == "__main__":
    main()
