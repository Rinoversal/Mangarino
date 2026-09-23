"""Build the app icon set from assets/logo/mangarino-logo.png. Run from the repo root."""
from PIL import Image, ImageChops

SRC = "assets/logo/mangarino-logo.png"
SIZE = 1024
NAVY = (8, 21, 59, 255)  # background colour sampled from the logo


def logo_square():
    im = Image.open(SRC).convert("RGBA")
    bg = Image.new("RGBA", im.size, NAVY)
    mask = ImageChops.difference(im, bg).convert("L").point(lambda v: 255 if v > 24 else 0)
    box = mask.getbbox()
    pad = 36
    l, t, r, b = max(0, box[0] - pad), max(0, box[1] - pad), min(im.width, box[2] + pad), min(im.height, box[3] + pad)
    crop = im.crop((l, t, r, b))
    side = max(crop.width, crop.height)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    return sq


def place(logo, canvas_bg, fraction, out):
    canvas = Image.new("RGBA", (SIZE, SIZE), canvas_bg)
    target = int(SIZE * fraction)
    scaled = logo.resize((target, target), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((SIZE - target) // 2, (SIZE - target) // 2))
    canvas.save(out)


logo = logo_square()
place(logo, NAVY, 0.92, "assets/images/icon.png")                       # legacy square icon
place(logo, (0, 0, 0, 0), 0.66, "assets/images/android-icon-foreground.png")  # adaptive safe zone
Image.new("RGBA", (SIZE, SIZE), NAVY).save("assets/images/android-icon-background.png")
Image.open("assets/images/android-icon-foreground.png").convert("LA").save("assets/images/android-icon-monochrome.png")
place(logo, (0, 0, 0, 0), 0.7, "assets/images/splash-icon.png")
print("icon set written from", SRC)
