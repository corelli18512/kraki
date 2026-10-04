#!/usr/bin/env node
/**
 * Build the Windows x64 SEA (kraki.exe) on any machine.
 *
 * Kraki for Windows ships the tentacle as resources\kraki\kraki.exe. The SEA
 * blob from `build:binary:local` is platform-independent, so it is injected
 * into the official Windows node.exe of the same Node version (checksum
 * verified), like build-sea-darwin-cross.mjs does for the other Mac slice.
 *
 * Usage (after build:binary:local):  node scripts/build-sea-windows-cross.mjs
 * Output: dist/sea/kraki-cli-windows-x64.exe
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seaDir = join(packageRoot, 'dist', 'sea');
const blobPath = join(seaDir, 'sea-prep.blob');
const outputPath = join(seaDir, 'kraki-cli-windows-x64.exe');

if (!existsSync(blobPath)) {
  console.error(`Missing ${blobPath}; run build:binary:local first`);
  process.exit(1);
}

const version = process.version;
const base = `https://nodejs.org/dist/${version}`;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const work = mkdtempSync(join(tmpdir(), 'kraki-sea-win-'));
try {
  console.log(`⬇️  ${base}/win-x64/node.exe`);
  const exe = await download(`${base}/win-x64/node.exe`);
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums.split('\n').find((l) => l.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(exe).digest('hex');
  if (!expected || expected !== actual) throw new Error('checksum mismatch for win-x64/node.exe');
  const nodeExe = join(work, 'node.exe');
  writeFileSync(nodeExe, exe);
  copyFileSync(nodeExe, outputPath);
  const postject = join(packageRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
  execFileSync(postject, [outputPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL_FUSE], {
    stdio: 'inherit', shell: process.platform === 'win32',
  });
  console.log(`✅ ${outputPath} (${(readFileSync(outputPath).length / 1e6).toFixed(1)} MB)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
