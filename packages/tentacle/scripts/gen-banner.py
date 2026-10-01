#!/usr/bin/env python3
"""Regenerate src/banner-data.json from the app's Kraki logo.

Each terminal cell holds two pixels (top/bottom, rendered with ▀/▄ and
true colour), so the logo is resized to WIDTH x (2 * rows).
Usage: python3 scripts/gen-banner.py [width]   (needs Pillow)
"""
import json, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'packages/arm/ios/Kraki/Resources/Assets.xcassets/KrakiLogo.imageset/logo-dark@3x.png'
OUT = Path(__file__).resolve().parents[1] / 'src/banner-data.json'
W = int(sys.argv[1]) if len(sys.argv) > 1 else 34

im = Image.open(SRC).convert('RGBA')
im = im.crop(im.getbbox())
H = round(im.size[1] / im.size[0] * W / 2) * 2
sm = im.resize((W, H), Image.LANCZOS)

def px(x, y):
    r, g, b, a = sm.getpixel((x, y))
    return None if a < 110 else '%02x%02x%02x' % (r, g, b)

rows = [[[px(x, y * 2), px(x, y * 2 + 1)] for x in range(W)] for y in range(H // 2)]
empty = lambda x: all(r[x] == [None, None] for r in rows)
while empty(0):
    for r in rows: r.pop(0)
while empty(len(rows[0]) - 1):
    for r in rows: r.pop()
data = {'source': 'KrakiLogo logo-dark (packages/arm/ios); regenerate with scripts/gen-banner.py',
        'w': len(rows[0]), 'h': len(rows), 'cells': rows}
OUT.write_text(json.dumps(data, separators=(',', ':')))
print(f'{OUT}: {data["w"]}x{data["h"]}')
