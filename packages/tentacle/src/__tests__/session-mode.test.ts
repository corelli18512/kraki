/** Three-mode rename (safe / auto / delegate) and its transition contract. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SESSION_MODE, EMIT_LEGACY_MODE_NAMES, normalizeSessionMode, toWireSessionMode } from '@kraki/protocol';
import { SessionManager } from '../session-manager.js';
import { krakiAutoApproves } from '../adapters/permission-policy.js';

describe('session mode names', () => {
  it('normalizes every legacy and current name; unknown falls back to the default', () => {
    expect(normalizeSessionMode('discuss')).toBe('auto');
    expect(normalizeSessionMode('execute')).toBe('auto');
    expect(normalizeSessionMode('auto')).toBe('auto');
    expect(normalizeSessionMode('safe')).toBe('safe');
    expect(normalizeSessionMode('delegate')).toBe('delegate');
    expect(normalizeSessionMode(undefined)).toBe(DEFAULT_SESSION_MODE);
    expect(DEFAULT_SESSION_MODE).toBe('auto');
  });

  it('puts the legacy wire name on the wire during the transition release', () => {
    expect(EMIT_LEGACY_MODE_NAMES).toBe(true);
    expect(toWireSessionMode('auto')).toBe('execute');
    expect(toWireSessionMode('safe')).toBe('safe');
    expect(toWireSessionMode('delegate')).toBe('delegate');
  });

  it('policy: safe gates side effects only; auto and delegate never ask', () => {
    for (const kind of ['read', 'url', 'meta'] as const) expect(krakiAutoApproves('safe', kind)).toBe(true);
    for (const kind of ['write', 'shell', 'mcp', 'other'] as const) {
      expect(krakiAutoApproves('safe', kind)).toBe(false);
      expect(krakiAutoApproves('auto', kind)).toBe(true);
      expect(krakiAutoApproves('delegate', kind)).toBe(true);
    }
  });
});

describe('SessionManager mode migration', () => {
  it('new sessions default to auto; four-mode sessions read as the new modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-modes-'));
    try {
      const sm = new SessionManager(dir);
      sm.createSession('pi', 'm', 'fresh');
      expect(sm.getMeta('fresh')!.mode).toBe('auto');

      for (const [id, legacy] of [['d', 'discuss'], ['e', 'execute'], ['s', 'safe']] as const) {
        sm.createSession('pi', 'm', id);
        const p = join(dir, id, 'meta.json');
        writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), mode: legacy }));
      }
      expect(sm.getMeta('d')!.mode).toBe('auto');
      expect(sm.getMeta('e')!.mode).toBe('auto');
      expect(sm.getMeta('s')!.mode).toBe('safe');
      // Session list carries the wire name.
      const list = Object.fromEntries(sm.getSessionList().map((x) => [x.id, x.mode]));
      expect(list).toMatchObject({ d: 'execute', e: 'execute', s: 'safe', fresh: 'execute' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
