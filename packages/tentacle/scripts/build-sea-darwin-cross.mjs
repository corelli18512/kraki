#!/usr/bin/env node
/**
 * Build the macOS SEA for the architecture this machine is NOT running.
 *
 * Kraki for Mac is universal, so its built-in tentacle needs both an arm64 and
 * an x86_64 slice. `build:binary:local` produces the native slice plus the
 * platform-independent SEA blob (dist/sea/sea-prep.blob). This script injects
 * that same blob into the official Node.js binary of the other architecture —
 * same Node version, so the blob format matches — and ad-hoc signs it.
 *
 * Usage (after build:binary:local):  node scripts/build-sea-darwin-cross.mjs
 * Output: dist/sea/kraki-cli-macos-<other arch>
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMachOUuid } from './macho-uuid.mjs';

if (process.platform !== 'darwin') {
  console.error('build-sea-darwin-cross only runs on macOS');
  process.exit(1);
}

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seaDir = join(packageRoot, 'dist', 'sea');
const blobPath = join(seaDir, 'sea-prep.blob');
const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
const outputPath = join(seaDir, `kraki-cli-macos-${otherArch}`);

if (!existsSync(blobPath)) {
  console.error(`Missing ${blobPath}; run build:binary:local first`);
  process.exit(1);
}

const version = process.version;
const dist = `node-${version}-darwin-${otherArch}`;
const url = `https://nodejs.org/dist/${version}/${dist}.tar.gz`;
const work = mkdtempSync(join(tmpdir(), 'kraki-sea-cross-'));
try {
  console.log(`⬇️  ${url}`);
  execFileSync('curl', ['-fsSL', '-o', join(work, 'node.tgz'), url], { stdio: 'inherit' });
  // Verify against the release's published checksums before using it.
  execFileSync('curl', ['-fsSL', '-o', join(work, 'SHASUMS256.txt'), `https://nodejs.org/dist/${version}/SHASUMS256.txt`], { stdio: 'inherit' });
  const sums = execFileSync('grep', [` ${dist}.tar.gz$`, join(work, 'SHASUMS256.txt')], { encoding: 'utf8' }).trim();
  const expected = sums.split(/\s+/)[0];
  const actual = execFileSync('shasum', ['-a', '256', join(work, 'node.tgz')], { encoding: 'utf8' }).split(/\s+/)[0];
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${dist}.tar.gz`);

  execFileSync('tar', ['-xzf', join(work, 'node.tgz'), '-C', work, `${dist}/bin/node`], { stdio: 'inherit' });
  execFileSync('cp', [join(work, dist, 'bin', 'node'), outputPath]);
  try { execFileSync('codesign', ['--remove-signature', outputPath]); } catch { /* unsigned */ }
  execFileSync(join(packageRoot, 'node_modules', '.bin', 'postject'), [
    outputPath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', SENTINEL_FUSE,
    '--macho-segment-name', 'NODE_SEA',
  ], { stdio: 'inherit' });
  // Same as build-local-binary: the CLI gets its own UUID, not Node's.
  for (const { arch, from, to } of setMachOUuid(outputPath, 'chat.kraki.cli')) {
    console.log(`🆔 ${arch} LC_UUID ${from} -> ${to}`);
  }
  execFileSync('codesign', ['--sign', '-', '--force', outputPath], { stdio: 'inherit' });
  chmodSync(outputPath, 0o755);
  console.log(`✅ ${outputPath} (${execFileSync('lipo', ['-archs', outputPath], { encoding: 'utf8' }).trim()})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
