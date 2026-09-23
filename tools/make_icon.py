"""Render Mangarino's placeholder icon set (navy page with pink M). Run from the repo root."""
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
BG = (11, 16, 32, 255)        # deep navy
ACCENT = (255, 45, 149, 255)  # neon pink
WHITE = (245, 245, 250, 255)
INK = (14, 18, 34, 255)


def page(draw, x, y, w, h, border=26):
    draw.rounded_rectangle([x, y, x + w, y + h], radius=40, fill=WHITE, outline=INK, width=border)
    gy = y + int(h * 0.46)
    draw.rectangle([x, gy - border // 2, x + w, gy + border // 2], fill=INK)
    gx = x + int(w * 0.5)
    draw.rectangle([gx - border // 2, gy, gx + border // 2, y + h], fill=INK)
    draw.polygon(
        [(x + int(w * 0.62), y), (x + int(w * 0.72), y), (x + int(w * 0.5), gy), (x + int(w * 0.4), gy)],
        fill=INK,
    )


def letter(draw, cx, cy, size):
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), "M", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), "M", font=font, fill=ACCENT)


def render(background, scale, out):
    img = Image.new("RGBA", (SIZE, SIZE), background)
    d = ImageDraw.Draw(img)
    w, h = int(430 * scale), int(560 * scale)
    x, y = (SIZE - w) // 2, (SIZE - h) // 2
    page(d, x, y, w, h, border=int(26 * scale))
    letter(d, x + int(w * 0.27), y + int(h * 0.24), int(230 * scale))
    img.save(out)


render(BG, 1.25, "assets/images/icon.png")
render((0, 0, 0, 0), 0.95, "assets/images/android-icon-foreground.png")
Image.new("RGBA", (SIZE, SIZE), BG).save("assets/images/android-icon-background.png")
Image.open("assets/images/android-icon-foreground.png").convert("LA").save("assets/images/android-icon-monochrome.png")
render((0, 0, 0, 0), 0.8, "assets/images/splash-icon.png")
print("icons written")
