#!/usr/bin/env python3
"""Render the Kraki.dmg window background (1x and 2x).

Run locally when the design changes and commit the PNGs; CI only consumes
them. Requires Pillow and macOS system fonts.

Layout matches settings.py: a 640x400 window, Kraki at (170, 180) and the
Applications alias at (470, 180), an arrow between them, a caption below.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
W, H = 640, 400
APP_X, APPS_X, ICON_Y = 170, 470, 180

FONT = "/System/Library/Fonts/SFNS.ttf"


def font(size: int, weight: str) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f


def render(scale: int) -> Image.Image:
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h))
    px = img.load()
    # Soft vertical gradient: near-white to a faint brand blue.
    top, bottom = (250, 251, 253), (234, 241, 250)
    for y in range(h):
        t = y / (h - 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        for x in range(w):
            px[x, y] = c

    d = ImageDraw.Draw(img)
    s = scale
    blue = (38, 99, 196)

    # Arrow between the two icons (icons are 128pt; leave clearance).
    y = ICON_Y * s
    x0, x1 = (APP_X + 88) * s, (APPS_X - 88) * s
    d.line([(x0, y), (x1 - 14 * s, y)], fill=blue, width=5 * s)
    d.polygon([(x1, y), (x1 - 20 * s, y - 12 * s), (x1 - 20 * s, y + 12 * s)], fill=blue)

    title = "Drag Kraki to Applications"
    sub = "Then open Kraki from your Applications folder."
    ft, fs = font(20 * s, "Semibold"), font(13 * s, "Regular")
    for text, f, ty, color in (
        (title, ft, 300, (29, 36, 51)),
        (sub, fs, 332, (98, 108, 126)),
    ):
        tw = d.textlength(text, font=f)
        d.text(((w - tw) / 2, ty * s), text, font=f, fill=color)
    return img


if __name__ == "__main__":
    render(1).save(HERE / "background.png", dpi=(72, 72))
    render(2).save(HERE / "background@2x.png", dpi=(144, 144))
    print("wrote", HERE / "background.png", HERE / "background@2x.png")
