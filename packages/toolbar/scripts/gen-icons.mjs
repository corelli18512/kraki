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

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

// ── App icon: real logo on orange rounded-rect background ──
function appIconSvg(size) {
  const pad = size * 0.10;
  const avail = size - pad * 2;
  const logoAspect = 1054 / 897;
  let w, h;
  if (logoAspect > 1) { w = avail; h = avail / logoAspect; }
  else { h = avail; w = avail * logoAspect; }
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#ea6046"/>
  <image href="data:image/png;base64,${logoBase64}" x="${x}" y="${y}" width="${w}" height="${h}"/>
</svg>`;
}

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
  const appPngs = {};
  for (const { size, name } of appIconSizes) {
    const svg = appIconSvg(size);
    const png = await svgToPng(svg, size, size);
    appPngs[size] = png;
    writeFileSync(join(iconsDir, `${name}.png`), png);
    console.log(`  ✓ ${name}.png`);
  }

  // ── icon.icns via iconutil (macOS) ──────────────────────
  if (process.platform === 'darwin') {
    const iconsetDir = join(iconsDir, 'icon.iconset');
    mkdirSync(iconsetDir, { recursive: true });
    // Also generate 16px and 64px for iconset
    for (const extra of [16, 64]) {
      if (!appPngs[extra]) appPngs[extra] = await svgToPng(appIconSvg(extra), extra, extra);
    }
    const iconsetMap = [
      [16,   'icon_16x16.png'],
      [32,   'icon_16x16@2x.png'],
      [32,   'icon_32x32.png'],
      [64,   'icon_32x32@2x.png'],
      [128,  'icon_128x128.png'],
      [256,  'icon_128x128@2x.png'],
      [256,  'icon_256x256.png'],
      [512,  'icon_256x256@2x.png'],
      [512,  'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ];
    for (const [size, fname] of iconsetMap) {
      writeFileSync(join(iconsetDir, fname), appPngs[size]);
    }
    execSync(`iconutil -c icns -o "${join(iconsDir, 'icon.icns')}" "${iconsetDir}"`, { stdio: 'pipe' });
    rmSync(iconsetDir, { recursive: true });
    console.log(`  ✓ icon.icns`);
  }

  // ── icon.ico (PNG-in-ICO wrapper) ─────────────────────
  const icoSizes = [16, 32, 48, 64, 128, 256];
  if (!appPngs[16]) appPngs[16] = await svgToPng(appIconSvg(16), 16, 16);
  if (!appPngs[48]) appPngs[48] = await svgToPng(appIconSvg(48), 48, 48);
  if (!appPngs[64]) appPngs[64] = await svgToPng(appIconSvg(64), 64, 64);
  const numImages = icoSizes.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numImages, 4);
  const dirEntries = Buffer.alloc(dirEntrySize * numImages);
  let offset = headerSize + dirEntrySize * numImages;
  const pngBuffers = icoSizes.map(s => appPngs[s]);
  for (let i = 0; i < numImages; i++) {
    const s = icoSizes[i];
    const buf = pngBuffers[i];
    const o = i * dirEntrySize;
    dirEntries.writeUInt8(s >= 256 ? 0 : s, o);
    dirEntries.writeUInt8(s >= 256 ? 0 : s, o + 1);
    dirEntries.writeUInt8(0, o + 2);
    dirEntries.writeUInt8(0, o + 3);
    dirEntries.writeUInt16LE(1, o + 4);
    dirEntries.writeUInt16LE(32, o + 6);
    dirEntries.writeUInt32LE(buf.length, o + 8);
    dirEntries.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  }
  writeFileSync(join(iconsDir, 'icon.ico'), Buffer.concat([header, dirEntries, ...pngBuffers]));
  console.log(`  ✓ icon.ico`);

  console.log('Icons ready.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
