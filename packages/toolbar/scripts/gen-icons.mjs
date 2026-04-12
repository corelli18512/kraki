/**
 * gen-icons.mjs — generate tray icon PNGs.
 *
 * macOS: monochrome silhouette (template image, OS auto-tints for light/dark)
 *   tray-connected.png, tray-connecting.png, tray-disconnected.png
 *
 * Windows: colored logo with status dot badge
 *   tray-connected-color.png  (green dot)
 *   tray-connecting-color.png (yellow dot)
 *   tray-disconnected-color.png (red dot)
 *
 * App icons: 32x32, 128x128, 128x128@2x
 *
 * Requires: @resvg/resvg-js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '../src-tauri/icons');
mkdirSync(iconsDir, { recursive: true });

// ── macOS: monochrome silhouette ────────────────────────
const trayIconSvg = readFileSync(join(__dirname, 'kraki-silhouette.svg'), 'utf8');
const trayIconDisconnectedSvg = trayIconSvg.replace(
  '<g transform=',
  '<g opacity="0.25"><g transform=',
).replace('</svg>', '</g></svg>');

// ── Windows: colored logo with status dot ───────────────
const logoPng = readFileSync(join(__dirname, '../../..', 'logo.png'));
const logoBase64 = logoPng.toString('base64');

function windowsTrayIconSvg(dotColor) {
  const size = 32;
  const dotR = 5;
  const dotCx = size - dotR - 1;
  const dotCy = size - dotR - 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <image href="data:image/png;base64,${logoBase64}" x="0" y="0" width="${size}" height="${size}"/>
    <circle cx="${dotCx}" cy="${dotCy}" r="${dotR}" fill="${dotColor}" stroke="white" stroke-width="1.5"/>
  </svg>`;
}

const appIconSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#ea6046"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.28}" fill="white"/>
</svg>`;

async function svgToPng(svg, width, height) {
  // Try @resvg/resvg-js first
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
    return resvg.render().asPng();
  } catch { /* not available */ }

  // Try sharp
  try {
    const sharp = (await import('sharp')).default;
    return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
  } catch { /* not available */ }

  // Fallback: write a minimal valid 1x1 transparent PNG
  // (hex for a 1x1 transparent PNG — valid enough for Rust to compile)
  console.warn(`  ⚠  No SVG renderer found for ${width}x${height} — writing placeholder PNG`);
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a' +
    '49444154789c6260000000020001e221bc330000000049454e44ae426082',
    'hex',
  );
}

async function main() {
  console.log('Generating icons…');

  // macOS tray icons (monochrome template)
  const macTray = {
    'tray-connected': trayIconSvg,
    'tray-connecting': trayIconSvg,
    'tray-disconnected': trayIconDisconnectedSvg,
  };
  for (const [name, svg] of Object.entries(macTray)) {
    const png = await svgToPng(svg, 44, 44);
    writeFileSync(join(iconsDir, `${name}.png`), png);
    console.log(`  ✓ ${name}.png (macOS)`);
  }

  // Windows tray icons (colored logo + status dot)
  const winTray = {
    'tray-connected-color': windowsTrayIconSvg('#22c55e'),     // green
    'tray-connecting-color': windowsTrayIconSvg('#eab308'),    // yellow
    'tray-disconnected-color': windowsTrayIconSvg('#ef4444'),  // red
  };
  for (const [name, svg] of Object.entries(winTray)) {
    const png = await svgToPng(svg, 32, 32);
    writeFileSync(join(iconsDir, `${name}.png`), png);
    console.log(`  ✓ ${name}.png (Windows)`);
  }

  const appIconSizes = [
    { size: 32,   name: '32x32' },
    { size: 128,  name: '128x128' },
    { size: 256,  name: '128x128@2x' },
    { size: 512,  name: '512x512' },
    { size: 1024, name: '512x512@2x' },
  ];
  for (const { size, name } of appIconSizes) {
    const svg = appIconSvg(size);
    const png = await svgToPng(svg, size, size);
    writeFileSync(join(iconsDir, `${name}.png`), png);
    console.log(`  ✓ ${name}.png`);
  }

  console.log('Icons ready.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
