#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
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

// "Lower Other Sounds While Recording" (voice-volume.cjs): its crash watchdog
// is Kraki.exe run as Node, so the RunAsNode fuse must stay enabled. Without
// it the watchdog never reports `ready` and the volume is never lowered.
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const exe = fileURLToPath(new URL('../../packages/desktop/release/win-unpacked/Kraki.exe', import.meta.url));
const wire = await getCurrentFuseWire(exe);
if (wire[FuseV1Options.RunAsNode] !== '1'.charCodeAt(0)) throw new Error('The RunAsNode fuse is disabled: the voice volume watchdog cannot start.');
// Only the built architecture's koffi module ships (package.json win.files).
const koffi = fileURLToPath(new URL('../../packages/desktop/release/win-unpacked/resources/app.asar.unpacked/node_modules/koffi/build/koffi/', import.meta.url));
deepStrictEqual(readdirSync(koffi), ['win32_x64']);
deepStrictEqual(readdirSync(`${koffi}win32_x64`), ['koffi.node']);
console.log('RunAsNode fuse enabled; koffi ships win32_x64 only.');
