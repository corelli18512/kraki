import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { patchInstalledLibraries, patchPackage } from './patch-npm-deps.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kraki-npm-deps-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const target = join(dir, 'target');
  for (const p of [source, target]) mkdirSync(join(p, 'dist'), { recursive: true });
  writeFileSync(join(source, 'dist/schemas.js'), 'export const current = true;');
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: '@kraki/protocol', version: '0.29.5', type: 'module', main: 'dist/index.js',
    exports: { './schemas': { import: './dist/schemas.js' } },
    dependencies: { zod: '^4.3.6' }, devDependencies: { typescript: '^5.7.0' }, scripts: { build: 'tsc' },
  }));
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@kraki/protocol', version: '0.29.4' }));
  return { source, target, dir };
}

test('overlays exports and runtime deps, preserves fixture version, installs inside target only', (t) => {
  const { source, target } = fixture(t);
  const calls = [];
  patchPackage(source, target, (args, cwd) => calls.push({ args, cwd }));
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.29.4');
  assert.equal(pkg.exports['./schemas'].import, './dist/schemas.js');
  assert.deepEqual(pkg.dependencies, { zod: '^4.3.6' });
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.match(readFileSync(join(target, 'dist/schemas.js'), 'utf8'), /current = true/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, target);
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.ok(calls[0].args.includes('--omit=dev'));
  assert.ok(!calls[0].args.includes('-g'));
});

test('dependency-free crypto overlay needs no npm operation', (t) => {
  const { source, target } = fixture(t);
  const pkg = { name: '@kraki/crypto', version: '0.2.2' };
  for (const dir of [source, target]) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  patchPackage(source, target, () => assert.fail('no install needed'));
});

test('missing installation fails instead of silently leaving an old package', (t) => {
  const { dir } = fixture(t);
  assert.throws(() => patchInstalledLibraries(dir, dir), /not found/);
});

test('wrong package name fails before changing installed metadata', (t) => {
  const { source, target } = fixture(t);
  writeFileSync(join(target, 'package.json'), '{"name":"wrong","version":"1.0.0"}');
  assert.throws(() => patchPackage(source, target), /Package mismatch/);
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name, 'wrong');
});
