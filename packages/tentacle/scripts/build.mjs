#!/usr/bin/env node

import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildInfo, writeBuildInfo } from '../../../scripts/release/build-info.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const distDir = join(packageRoot, 'dist');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

if (process.platform === 'win32') {
  const result = spawnSync(pnpmCommand, ['exec', 'tsc'], {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${pnpmCommand} exec tsc`);
  }
} else {
  execFileSync(pnpmCommand, ['exec', 'tsc'], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
}

cpSync(join(packageRoot, 'src', 'banner-data.json'), join(distDir, 'banner-data.json'));
writeBuildInfo(join(distDir, 'build-info.json'), createBuildInfo({
  component: 'cli', version: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
  cwd: packageRoot,
}));
