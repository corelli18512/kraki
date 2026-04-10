/**
 * gen-icons.mjs — generate tray icon PNGs from the kraki silhouette SVG.
 *
 * Produces:
 *   src-tauri/icons/tray-connected.png     (22x22 — macOS template, kraki logo)
 *   src-tauri/icons/tray-connecting.png    (22x22 — macOS template, kraki logo)
 *   src-tauri/icons/tray-disconnected.png  (22x22 — macOS template, kraki logo)
 *   src-tauri/icons/32x32.png              (app icon placeholder)
 *   src-tauri/icons/128x128.png
 *   src-tauri/icons/128x128@2x.png
 *
 * The tray icon uses the kraki octopus silhouette (potrace + manual eyes).
 * All three states use the same icon — macOS renders it as a template image.
 *
 * Requires: @resvg/resvg-js (installed as dev dep, or falls back to sharp if available)
 * If neither is available, writes minimal 1x1 placeholder PNGs so the build doesn't fail.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '../src-tauri/icons');
mkdirSync(iconsDir, { recursive: true });

// Load the kraki silhouette SVG (potrace-traced logo with manually added eyes)
const trayIconSvg = readFileSync(join(__dirname, 'kraki-silhouette.svg'), 'utf8');
// Disconnected variant: wrap in a group with reduced opacity
const trayIconDisconnectedSvg = trayIconSvg.replace(
  '<g transform=',
  '<g opacity="0.25"><g transform=',
).replace('</svg>', '</g></svg>');

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

  // Tray icons — connected/connecting use full opacity, disconnected is dimmed
  const trayVariants = {
    'tray-connected': trayIconSvg,
    'tray-connecting': trayIconSvg,
    'tray-disconnected': trayIconDisconnectedSvg,
  };
  for (const [name, svg] of Object.entries(trayVariants)) {
    const png = await svgToPng(svg, 44, 44); // 44px for @2x Retina
    const out = join(iconsDir, `${name}.png`);
    writeFileSync(out, png);
    console.log(`  ✓ ${name}.png`);
  }

  for (const size of [32, 128, 256]) {
    const svg = appIconSvg(size);
    const png = await svgToPng(svg, size, size);
    const name = size === 256 ? '128x128@2x' : `${size}x${size}`;
    writeFileSync(join(iconsDir, `${name}.png`), png);
    console.log(`  ✓ ${name}.png`);
  }

  console.log('Icons ready.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
