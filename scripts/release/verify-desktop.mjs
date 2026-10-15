#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../packages/desktop/package.json', import.meta.url));
const { extractFile } = require('@electron/asar');
const archive = fileURLToPath(new URL('../../packages/desktop/release/win-unpacked/resources/app.asar', import.meta.url));
const expected = JSON.parse(readFileSync(new URL('../../packages/desktop/src/build-info.json', import.meta.url), 'utf8'));
const actual = JSON.parse(extractFile(archive, 'src/build-info.json').toString('utf8'));
deepStrictEqual(actual, expected);
if (!extractFile(archive, 'app/index.html').length) throw new Error('Missing desktop UI');
console.log('Packaged desktop build identity matches the source build.');
