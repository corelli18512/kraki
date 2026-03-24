#!/usr/bin/env node

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const distDir = join(packageRoot, 'dist');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

execFileSync(pnpmCommand, ['exec', 'tsc'], {
  cwd: packageRoot,
  stdio: 'inherit',
});

cpSync(join(packageRoot, 'src', 'banner-data.json'), join(distDir, 'banner-data.json'));
