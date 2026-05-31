/**
 * Unit tests for sanitizeCopilotEventsFile.
 *
 * This is the function that pre-scans `~/.copilot/session-state/<id>/events.jsonl`
 * before resume and repairs known Copilot CLI writer-side schema violations
 * (currently: negative `tokensRemoved` on `session.compaction_complete`).
 *
 * The tests use a real tmp directory and real fs so they exercise the
 * atomic write-back path and verify byte-level file shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sanitizeCopilotEventsFile } from '../copilot.js';

describe('sanitizeCopilotEventsFile', () => {
  let dir: string;
  let eventsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-sanitize-test-'));
    eventsPath = join(dir, 'events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 and does not create a file when path does not exist', () => {
    const fixed = sanitizeCopilotEventsFile(eventsPath);
    expect(fixed).toBe(0);
    expect(existsSync(eventsPath)).toBe(false);
  });

  it('returns 0 and leaves a clean file byte-identical', () => {
    const original = [
      '{"type":"user.message","data":{"content":"hi"}}',
      '{"type":"session.compaction_complete","data":{"tokensRemoved":1234}}',
      '{"type":"assistant.message","data":{"content":"hello"}}',
      '',
    ].join('\n');
    writeFileSync(eventsPath, original, 'utf8');

    const fixed = sanitizeCopilotEventsFile(eventsPath);

    expect(fixed).toBe(0);
    expect(readFileSync(eventsPath, 'utf8')).toBe(original);
  });

  it('clamps negative tokensRemoved to 0 and reports the count', () => {
    const original = [
      '{"type":"session.compaction_complete","data":{"tokensRemoved":-2098}}',
      '{"type":"assistant.message","data":{"content":"ok"}}',
      '{"type":"session.compaction_complete","data":{"tokensRemoved":-442}}',
      '{"type":"session.compaction_complete","data":{"tokensRemoved":7}}',
      '{"type":"session.compaction_complete","data":{"tokensRemoved":-1638}}',
      '',
    ].join('\n');
    writeFileSync(eventsPath, original, 'utf8');

    const fixed = sanitizeCopilotEventsFile(eventsPath);

    expect(fixed).toBe(3);
    const after = readFileSync(eventsPath, 'utf8');
    expect(after).not.toContain('-2098');
    expect(after).not.toContain('-442');
    expect(after).not.toContain('-1638');

    // Re-parse line-by-line to confirm structural correctness
    const lines = after.split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const data = ev.data as Record<string, unknown> | undefined;
      if (typeof data?.tokensRemoved === 'number') {
        expect(data.tokensRemoved).toBeGreaterThanOrEqual(0);
      }
    }
    // The previously-clean entry must be untouched at value level
    const clean = JSON.parse(lines[3]) as { data: { tokensRemoved: number } };
    expect(clean.data.tokensRemoved).toBe(7);
  });

  it('preserves malformed lines verbatim (does not crash, does not rewrite line)', () => {
    const original = [
      '{"type":"session.compaction_complete","data":{"tokensRemoved":-1}}',
      '{this is not valid json',
      '{"type":"session.compaction_complete","data":{"tokensRemoved":-2}}',
      '',
    ].join('\n');
    writeFileSync(eventsPath, original, 'utf8');

    const fixed = sanitizeCopilotEventsFile(eventsPath);

    expect(fixed).toBe(2);
    const after = readFileSync(eventsPath, 'utf8');
    expect(after).toContain('{this is not valid json');
    // Both fixable lines must be repaired
    expect(after).not.toContain('-1');
    expect(after).not.toContain('-2');
  });

  it('ignores positive zero and rounding edge cases', () => {
    const original = [
      '{"type":"session.compaction_complete","data":{"tokensRemoved":0}}',
      '{"type":"session.compaction_complete","data":{"tokensRemoved":0.0}}',
      '{"type":"session.compaction_complete","data":{"tokensRemoved":-0}}',
      '',
    ].join('\n');
    writeFileSync(eventsPath, original, 'utf8');
    const fixed = sanitizeCopilotEventsFile(eventsPath);
    // -0 < 0 is false in JS so it should not count as a fix
    expect(fixed).toBe(0);
  });

  it('does not modify other negative numeric fields under data', () => {
    const original = [
      '{"type":"x","data":{"someOtherCounter":-5}}',
      '{"type":"y","data":{"unrelated":-100,"tokensRemoved":3}}',
      '',
    ].join('\n');
    writeFileSync(eventsPath, original, 'utf8');
    const fixed = sanitizeCopilotEventsFile(eventsPath);
    expect(fixed).toBe(0);
    // File unchanged
    expect(readFileSync(eventsPath, 'utf8')).toBe(original);
  });

  it('handles events without a data field', () => {
    const original = [
      '{"type":"session.compaction_complete"}',
      '{"type":"x","data":null}',
      '{"type":"y","data":"a string"}',
      '{"type":"z","data":42}',
      '',
    ].join('\n');
    writeFileSync(eventsPath, original, 'utf8');
    const fixed = sanitizeCopilotEventsFile(eventsPath);
    expect(fixed).toBe(0);
  });

  it('atomic write: does not leave .tmp file behind on success', () => {
    writeFileSync(eventsPath, '{"data":{"tokensRemoved":-1}}\n', 'utf8');
    sanitizeCopilotEventsFile(eventsPath);
    expect(existsSync(`${eventsPath}.kraki-sanitize.tmp`)).toBe(false);
  });
});
