/**
 * Session usage for Pi (K-289): pi's totals arrive from get_session_stats
 * after the turn's idle was already sent, and a resumed pi process starts
 * from zero until the first refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAdapter } from '../adapters/pi.js';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import type { AgentAdapter } from '../adapters/base.js';
import { turnFixture } from './helpers/turn-fixture.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const usage = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 0, totalCost: 0.02, totalDurationMs: 9000 };

describe('PiAdapter.setSessionUsage (K-289)', () => {
  it('restores the persisted totals into a resumed session', () => {
    const adapter = new PiAdapter({ cliPath: '/unused' });
    const session = { proc: { alive: true }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, totalDurationMs: 0 }, turn: turnFixture(adapter, 's1') };
    (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', session);
    adapter.setSessionUsage('s1', usage);
    expect(adapter.getSessionUsage('s1')).toEqual(usage);
    expect(() => adapter.setSessionUsage('missing', usage)).not.toThrow();
  });
});

describe('a usage update after the turn idled (K-289)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-usage-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function build() {
    const sm = new SessionManager(dir);
    const adapter = { generateTitle: vi.fn(async () => null), getSessionUsage: vi.fn(() => null), registerSessionAgent: vi.fn() } as Record<string, unknown>;
    const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
      relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
    });
    const broadcast = vi.spyOn(client, 'broadcastSessionList').mockImplementation(() => {});
    const update = adapter.onUsageUpdate as (sid: string, u: typeof usage) => void;
    return { sm, broadcast, update };
  }

  it('reaches the apps through the session list', () => {
    const { sm, broadcast, update } = build();
    const { sessionId } = sm.createSession('pi');
    sm.markIdle(sessionId);
    update(sessionId, usage);
    expect(sm.getMeta(sessionId)?.usage).toEqual(usage);
    expect(broadcast).toHaveBeenCalledTimes(1);
    // The same totals again change nothing.
    update(sessionId, { ...usage });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('waits for the closing idle while the turn runs', () => {
    const { sm, broadcast, update } = build();
    const { sessionId } = sm.createSession('pi');
    update(sessionId, usage);
    expect(sm.getMeta(sessionId)?.usage).toEqual(usage);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
