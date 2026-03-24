#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');

rmSync(resolve(packageRoot, 'dist'), { recursive: true, force: true });
