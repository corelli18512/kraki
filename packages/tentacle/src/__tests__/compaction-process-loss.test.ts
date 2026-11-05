/**
 * K-130: compaction is maintenance with its own end event. When the agent
 * process dies mid-compaction that end never comes; the relay must clear the
 * indicator itself, and a later prompt must be announced active again.
 * Real SessionManager on a temp dir, fake adapter, no sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import { handleConsumerMessage } from '../relay/consumer-messages.js';
import type { AgentAdapter } from '../adapters/base.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

type Cb = (sessionId: string, event?: Record<string, unknown>) => void;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-compaction-loss-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build() {
  const adapter: Record<string, unknown> = {
    generateTitle: vi.fn(async () => null),
    setSessionMode: vi.fn(),
    getSessionUsage: vi.fn(() => null),
    setSessionUsage: vi.fn(),
    registerSessionAgent: vi.fn(),
    setTurnIdentity: vi.fn(),
    isTurnSettled: vi.fn(() => false),
    sendMessage: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => {}),
    setSessionModel: vi.fn(async () => {}),
  };
  const sm = new SessionManager(dir);
  const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
    relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
  });
  const sent: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const send = client.send.bind(client);
  client.send = ((msg, ...rest) => { sent.push(msg as (typeof sent)[number]); send(msg, ...rest); }) as typeof client.send;
  const cb = (name: string) => adapter[name] as Cb;
  const input = (sessionId: string, text: string, clientId: string) =>
    handleConsumerMessage(client, { type: 'send_input', sessionId, deviceId: 'app-1', payload: { text, clientId } });
  return { adapter, sm, client, sent, cb, input };
}

describe('K-130: compaction when the agent process is lost', () => {
  it('eviction during threshold compaction ends the indicator and the next prompt is active', async () => {
    const { adapter, sm, client, sent, cb, input } = build();
    const { sessionId } = sm.createSession('claude');
    input(sessionId, 'A', 'cid-a');
    await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(1));
    cb('onMessage')(sessionId, { content: 'done' });
    cb('onIdle')(sessionId);
    cb('onCompaction')(sessionId, { phase: 'start', reason: 'threshold' });
    expect(client.compactingSessions.has(sessionId)).toBe(true);

    cb('onSessionEvicted')(sessionId);

    expect(client.compactingSessions.has(sessionId)).toBe(false);
    expect(sent.filter((m) => m.type === 'compacting').map((m) => m.payload?.phase)).toEqual(['start', 'end']);

    sent.length = 0;
    input(sessionId, 'B', 'cid-b');
    await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(2));
    expect(sent.some((m) => m.type === 'active')).toBe(true);
    expect(sm.getMeta(sessionId)?.state).toBe('active');
  });

  it('a follow-up queued behind the compaction is closed by the failure idle, not left active', async () => {
    const { adapter, sm, client, sent, cb, input } = build();
    const { sessionId } = sm.createSession('claude');
    input(sessionId, 'A', 'cid-a');
    await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(1));
    cb('onIdle')(sessionId);
    cb('onCompaction')(sessionId, { phase: 'start', reason: 'threshold' });
    input(sessionId, 'B', 'cid-b');
    await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(client.maintenanceFollowUps.get(sessionId)?.accepted).toBe(true));

    sent.length = 0;
    cb('onSessionEvicted')(sessionId);

    const types = sent.map((m) => m.type);
    // The compaction end (announcing B active) comes before B's failure idle.
    expect(types.indexOf('compacting')).toBeGreaterThanOrEqual(0);
    expect(types.lastIndexOf('active')).toBeLessThan(types.lastIndexOf('idle'));
    expect(sm.getMeta(sessionId)?.state).toBe('disconnected');
    expect(client.maintenanceFollowUps.has(sessionId)).toBe(false);
  });
});
