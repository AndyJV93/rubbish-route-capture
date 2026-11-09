#!/usr/bin/env python3
"""Generate the PWA icons (a route: three numbered stops joined by a line)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "icons"
GREEN, WHITE = (27, 94, 59), (255, 255, 255)


def font(size):
    for name in ("DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw(size, maskable=False):
    img = Image.new("RGBA", (size, size), GREEN if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * (0.12 if maskable else 0.04)
    if not maskable:
        d.rounded_rectangle((pad, pad, size - pad, size - pad), radius=size * 0.2, fill=GREEN)
    # Route line through three stops
    pts = [(size * 0.28, size * 0.70), (size * 0.50, size * 0.36), (size * 0.72, size * 0.64)]
    d.line(pts, fill=WHITE, width=max(3, int(size * 0.05)), joint="curve")
    r = size * 0.11
    f = font(int(size * 0.13))
    for i, (x, y) in enumerate(pts, 1):
        d.ellipse((x - r, y - r, x + r, y + r), fill=WHITE)
        d.text((x, y), str(i), fill=GREEN, font=f, anchor="mm")
    return img


OUT.mkdir(exist_ok=True)
draw(192).save(OUT / "icon-192.png")
draw(512).save(OUT / "icon-512.png")
draw(512, maskable=True).save(OUT / "icon-maskable-512.png")
print("icons written to", OUT)
