#!/usr/bin/env node
/**
 * SwiftLint with a ratchet baseline (see packages/arm/ios/.swiftlint.yml).
 *
 * Violations are keyed by rule, file and the source line they point at (the
 * `func …` / `class …` line; the file itself for file_length). Against the
 * baseline, a key may not gain violations and a size (lines, complexity) may
 * not grow. Staying the same or shrinking passes. SwiftLint's own baseline
 * compares the message text, which contains the size, so it would also fail
 * when a long file gets shorter.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const IOS = join(ROOT, 'packages/arm/ios');
const BASELINE = join(IOS, '.swiftlint-baseline.json');
const SIZED = new Set(['file_length', 'type_body_length', 'function_body_length', 'cyclomatic_complexity']);

/** SwiftLint JSON → [{ rule, file, subject, size, line, reason }]. */
export function normalize(violations, readLines) {
  const cache = new Map();
  return violations.map((v) => {
    const file = v.file;
    if (!cache.has(file)) cache.set(file, readLines(file));
    const subject = v.rule_id === 'file_length' ? '' : (cache.get(file)[(v.line ?? 1) - 1] ?? '').trim();
    const numbers = (v.reason.match(/\d+/g) ?? []).map(Number);
    const size = SIZED.has(v.rule_id) ? numbers.at(-1) ?? 0 : 0;
    return { rule: v.rule_id, file, subject, size, line: v.line, reason: v.reason };
  });
}

const keyOf = (v) => `${v.rule}\u0000${v.file}\u0000${v.subject}`;

function group(list) {
  const map = new Map();
  for (const v of list) {
    const key = keyOf(v);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  for (const items of map.values()) items.sort((a, b) => b.size - a.size);
  return map;
}

/** Current violations that are new or bigger than the baseline allows. */
export function regressions(baseline, current) {
  const allowed = group(baseline);
  const failures = [];
  for (const [key, items] of group(current)) {
    const base = allowed.get(key) ?? [];
    items.forEach((v, i) => {
      if (i >= base.length) failures.push({ ...v, was: null });
      else if (v.size > base[i].size) failures.push({ ...v, was: base[i].size });
    });
  }
  return failures;
}

/** Baseline entries: stable order, no line numbers (they move on every edit). */
export function baselineEntries(current) {
  return current
    .map(({ rule, file, subject, size }) => ({ rule, file, subject, size }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule)
      || a.subject.localeCompare(b.subject) || b.size - a.size);
}

function lint() {
  let out;
  try {
    out = execFileSync('swiftlint', ['lint', '--config', '.swiftlint.yml', '--reporter', 'json', '--quiet'],
      { cwd: IOS, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    // Exit code 2 = violations at error severity; the JSON is still complete.
    if (typeof error.stdout !== 'string' || !error.stdout.trim().startsWith('[')) throw error;
    out = error.stdout;
  }
  const raw = JSON.parse(out).map((v) => ({ ...v, file: relative(IOS, v.file) }));
  return normalize(raw, (file) => readFileSync(join(IOS, file), 'utf8').split('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const current = lint();
  if (process.argv.includes('--update')) {
    // One entry per line: a split's baseline diff reads as moved lines.
    writeFileSync(BASELINE, `[\n${baselineEntries(current).map((e) => JSON.stringify(e)).join(',\n')}\n]\n`);
    console.log(`baseline: ${current.length} accepted violations → ${relative(ROOT, BASELINE)}`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const failures = regressions(baseline, current);
  for (const f of failures) {
    const growth = f.was === null ? 'new' : `grew from ${f.was}`;
    console.log(`packages/arm/ios/${f.file}:${f.line}: ${f.rule} (${growth}): ${f.reason}`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} SwiftLint violation(s) beyond the baseline. Fix them; if the code only`
      + ' moved (a file split), run `node scripts/ci/swiftlint-ratchet.mjs --update` in the same PR.');
    process.exit(1);
  }
  console.log(`SwiftLint: ${current.length} violations, none beyond the baseline (${baseline.length}).`);
}
