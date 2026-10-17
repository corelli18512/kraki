#!/usr/bin/env python3
"""Windows tray icons from the Mac menu-bar silhouette (MenuBarKraki.pdf).

Like macOS template images, Windows tray glyphs are monochrome and follow the
taskbar: white on a dark taskbar, black on a light one. States mirror
MacPresence.image(status:needsYou:): full opacity online, 0.6 while going
online/offline, 0.4 offline; "needs you" knocks a gap out of the silhouette and
draws a dot. Multi-size .ico so every DPI gets a crisp frame.

Dev-only; outputs are committed. Requires Ghostscript and Pillow:
  python3 packages/desktop/scripts/make-tray-icons.py
"""
import os, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.join(HERE, '../../arm/ios/Kraki/Resources/Assets.xcassets/MenuBarKraki.imageset/MenuBarKraki.pdf')
OUT = os.path.join(HERE, '../build/tray')
SIZES = [16, 20, 24, 32, 40, 48, 64]
BIG = 512
STATES = {'online': (1.0, None), 'transition': (0.6, None), 'offline': (0.4, None), 'attention': (1.0, (255, 149, 0))}
THEMES = {'dark': (255, 255, 255), 'light': (0, 0, 0)}  # taskbar theme → glyph color

def silhouette():
    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, 's.png')
        # 18pt artboard → BIG px.
        subprocess.run(['gs', '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pngalpha',
                        f'-r{BIG * 72 / 18:.3f}', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                        f'-sOutputFile={png}', PDF], check=True)
        im = Image.open(png).convert('RGBA').resize((BIG, BIG), Image.LANCZOS)
    return im.getchannel('A')

def frame(mask, color, alpha, dot):
    a = mask.point(lambda v: int(v * alpha))
    if dot:
        # Mac: centre (maxX-2.4, maxY-2.6) r=2.2 on 18pt, gap +1.2.
        s = BIG / 18
        cx, cy, r, gap = BIG - 2.4 * s, 2.6 * s, 2.6 * s, 1.2 * s
        knock = Image.new('L', (BIG, BIG), 255)
        ImageDraw.Draw(knock).ellipse((cx - r - gap, cy - r - gap, cx + r + gap, cy + r + gap), fill=0)
        a = Image.composite(a, Image.new('L', (BIG, BIG), 0), knock)
    im = Image.new('RGBA', (BIG, BIG), color + (0,))
    im.putalpha(a)
    if dot:
        ImageDraw.Draw(im).ellipse((cx - r, cy - r, cx + r, cy + r), fill=dot + (255,))
    return im

# Taskbar overlay badge (Mac Dock badge count): red disc, white count, 1–9 and 9+.
BADGE_SIZES = [16, 20, 24, 32, 40, 48]
FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

def badge(label):
    im = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((0, 0, BIG - 1, BIG - 1), fill=(196, 43, 28, 255))  # Windows critical red
    size = int(BIG * (0.62 if len(label) == 1 else 0.46))
    font = ImageFont.truetype(FONT, size)
    l, t, r, b = d.textbbox((0, 0), label, font=font)
    d.text(((BIG - (r - l)) / 2 - l, (BIG - (b - t)) / 2 - t), label, font=font, fill=(255, 255, 255, 255))
    return im

def main():
    os.makedirs(OUT, exist_ok=True)
    mask = silhouette()
    for theme, color in THEMES.items():
        for state, (alpha, dot) in STATES.items():
            big = frame(mask, color, alpha, dot)
            frames = [big.resize((n, n), Image.LANCZOS) for n in SIZES]
            path = os.path.join(OUT, f'tray-{state}-{theme}.ico')
            frames[-1].save(path, format='ICO', sizes=[(n, n) for n in SIZES], append_images=frames[:-1])
    for n in list(range(1, 10)) + ['9+']:
        big = badge(str(n))
        frames = [big.resize((k, k), Image.LANCZOS) for k in BADGE_SIZES]
        name = 'badge-9plus' if n == '9+' else f'badge-{n}'
        frames[-1].save(os.path.join(OUT, f'{name}.ico'), format='ICO', sizes=[(k, k) for k in BADGE_SIZES], append_images=frames[:-1])
    print('wrote', OUT)

if __name__ == '__main__':
    main()
