#!/usr/bin/env python3
"""Windows icons from the colour Kraki logo (no background tile).

Windows app and tray icons are full-colour glyphs that fill their frame (no
macOS-style squircle backplate), so at 16–24 px the octopus gets the whole
square instead of ~64% of it.

  build/icon.ico, build/icon.png   app / taskbar / installer / toast icon
  build/tray/tray-<state>-<theme>.ico
      state  online | transition (going online/offline) | offline | attention
      theme  dark | light taskbar (logo-dark.png vs logo.png)
      States mirror MacPresence: 0.6 while going online/offline, 0.4 and
      desaturated offline, a dot when sessions need you.
  build/tray/badge-<n>.ico          taskbar overlay unread count (Dock badge)

Dev-only; outputs are committed. Requires Pillow:
  python3 packages/desktop/scripts/make-tray-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '../../arm/web/public')
BUILD = os.path.join(HERE, '../build')
OUT = os.path.join(BUILD, 'tray')
BIG = 512
TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]
APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
LOGO = {'light': 'logo.png', 'dark': 'logo-dark.png'}  # taskbar theme → artwork


def glyph(name, pad):
    """The logo trimmed to its pixels and centred in a square, `pad` fraction margin."""
    im = Image.open(os.path.join(PUBLIC, name)).convert('RGBA')
    im = im.crop(im.getchannel('A').getbbox())
    inner = round(BIG * (1 - 2 * pad))
    scale = inner / max(im.size)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    out = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
    out.alpha_composite(im, ((BIG - im.width) // 2, (BIG - im.height) // 2))
    return out


def fade(im, alpha, grey=False):
    if grey:
        a = im.getchannel('A')
        im = ImageEnhance.Color(im).enhance(0.15)
        im.putalpha(a)
    a = im.getchannel('A').point(lambda v: int(v * alpha))
    im = im.copy()
    im.putalpha(a)
    return im


def with_dot(im, color):
    s = BIG / 18  # Mac menu-bar geometry on an 18 pt artboard
    cx, cy, r, gap = BIG - 3.0 * s, 3.0 * s, 3.0 * s, 1.2 * s
    knock = Image.new('L', (BIG, BIG), 255)
    ImageDraw.Draw(knock).ellipse((cx - r - gap, cy - r - gap, cx + r + gap, cy + r + gap), fill=0)
    im = im.copy()
    im.putalpha(Image.composite(im.getchannel('A'), Image.new('L', (BIG, BIG), 0), knock))
    ImageDraw.Draw(im).ellipse((cx - r, cy - r, cx + r, cy + r), fill=color + (255,))
    return im


def save_ico(big, path, sizes):
    frames = [big.resize((n, n), Image.LANCZOS) for n in sizes]
    frames[-1].save(path, format='ICO', sizes=[(n, n) for n in sizes], append_images=frames[:-1])


BADGE_SIZES = [16, 20, 24, 32, 40, 48]
FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'


def badge(label):
    im = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((0, 0, BIG - 1, BIG - 1), fill=(196, 43, 28, 255))  # Windows critical red
    font = ImageFont.truetype(FONT, int(BIG * (0.62 if len(label) == 1 else 0.46)))
    l, t, r, b = d.textbbox((0, 0), label, font=font)
    d.text(((BIG - (r - l)) / 2 - l, (BIG - (b - t)) / 2 - t), label, font=font, fill=(255, 255, 255, 255))
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    # App icon: the glyph fills the frame like other Windows apps.
    app = glyph(LOGO['light'], 0.02)
    save_ico(app, os.path.join(BUILD, 'icon.ico'), APP_SIZES)
    app.save(os.path.join(BUILD, 'icon.png'))
    # Toasts scale the given PNG without smoothing: hand them one already
    # resampled near their display size (48 px at 100%, up to 2x).
    app.resize((96, 96), Image.LANCZOS).save(os.path.join(BUILD, 'toast.png'))
    # Tray: no padding at all; the notification area already spaces icons.
    for theme, name in LOGO.items():
        g = glyph(name, 0.0)
        states = {
            'online': g,
            'transition': fade(g, 0.6),
            'offline': fade(g, 0.45, grey=True),
            'attention': with_dot(g, (255, 140, 0)),
        }
        for state, im in states.items():
            save_ico(im, os.path.join(OUT, f'tray-{state}-{theme}.ico'), TRAY_SIZES)
    for n in list(range(1, 10)) + ['9+']:
        name = 'badge-9plus' if n == '9+' else f'badge-{n}'
        save_ico(badge(str(n)), os.path.join(OUT, f'{name}.ico'), BADGE_SIZES)
    print('wrote', BUILD)


if __name__ == '__main__':
    main()
