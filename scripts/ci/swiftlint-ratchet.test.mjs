import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineEntries, normalize, regressions } from './swiftlint-ratchet.mjs';

const v = (rule, file, subject, size = 0) => ({ rule, file, subject, size });

test('unchanged and shrinking violations pass', () => {
  const base = [v('file_length', 'A.swift', '', 1200), v('function_body_length', 'A.swift', 'func f() {', 120)];
  assert.deepEqual(regressions(base, base), []);
  assert.deepEqual(regressions(base, [v('file_length', 'A.swift', '', 900)]), []);
});

test('a growing file or function fails', () => {
  const base = [v('file_length', 'A.swift', '', 1200), v('function_body_length', 'A.swift', 'func f() {', 120)];
  const failures = regressions(base, [v('file_length', 'A.swift', '', 1201), v('function_body_length', 'A.swift', 'func f() {', 120)]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].was, 1200);
});

test('a new violation fails, including one more of the same line', () => {
  const base = [v('force_try', 'A.swift', 'let x = try! y()')];
  assert.equal(regressions(base, [...base, v('force_try', 'A.swift', 'let x = try! y()')]).length, 1);
  assert.equal(regressions(base, [v('force_try', 'B.swift', 'let x = try! y()')])[0].was, null);
});

test('subjects are the source line; file_length has none; sizes from the message', () => {
  const lines = ['import X', '  func f() {', '  }'];
  const [fn, file] = normalize([
    { rule_id: 'function_body_length', file: 'A.swift', line: 2, reason: 'Function body should span 80 lines or less excluding comments and whitespace: currently spans 95 lines' },
    { rule_id: 'file_length', file: 'A.swift', line: 900, reason: 'File should contain 800 lines or less excluding comments and whitespaces: currently contains 900' },
  ], () => lines);
  assert.deepEqual([fn.subject, fn.size], ['func f() {', 95]);
  assert.deepEqual([file.subject, file.size], ['', 900]);
});

test('baseline entries drop line numbers and sort stably', () => {
  const out = baselineEntries([{ ...v('force_try', 'B.swift', 'x'), line: 3 }, { ...v('force_try', 'A.swift', 'x'), line: 9 }]);
  assert.deepEqual(out.map((e) => e.file), ['A.swift', 'B.swift']);
  assert.equal('line' in out[0], false);
});
