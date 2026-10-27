import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apple-apply.mjs');

/** `apple-apply --check` (never writes the catalog) on one translation table. */
function check(translations) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-l10n-'));
  const file = path.join(dir, 'table.json');
  try {
    writeFileSync(file, JSON.stringify({ translations }));
    try { return { status: 0, output: execFileSync(process.execPath, [script, '--check', file], { encoding: 'utf8' }) }; }
    catch (error) { return { status: error.status, output: String(error.stdout) }; }
  } finally { rmSync(dir, { recursive: true }); }
}

test('apply refuses the same specifier mismatches as l10n:check, including %lf', () => {
  assert.equal(check({ Cancel: '取消' }).status, 0);
  for (const zh of ['取消 %lf', '取消 %.1lf', '取消 %@']) {
    const result = check({ Cancel: zh });
    assert.equal(result.status, 1, zh);
    assert.match(result.output, /format specifier mismatch/, zh);
  }
});
