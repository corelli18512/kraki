/**
 * Terminal rows of a turn: what lands on the spine when a turn ends without
 * a final reply (K-048) or is stopped before any output (K-067).
 * Real SessionManager on a temp dir, fake adapter, no sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import { ABORT_HUNG_MS, handleConsumerMessage } from '../relay/consumer-messages.js';
import type { AgentAdapter } from '../adapters/base.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

type Fn = ReturnType<typeof vi.fn>;
type Cb = (sessionId: string, event?: Record<string, unknown>) => void;

function createAdapter() {
  return {
    generateTitle: vi.fn(async () => null),
    setSessionMode: vi.fn(),
    getSessionUsage: vi.fn(() => null),
    setSessionUsage: vi.fn(),
    registerSessionAgent: vi.fn(),
    setTurnIdentity: vi.fn(),
    isTurnSettled: vi.fn(() => false),
    sendMessage: vi.fn(async () => {}),
    respondToQuestion: vi.fn(async () => 'accepted'),
    respondToPermission: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => {}),
    setSessionModel: vi.fn(async () => {}),
  } as Record<string, unknown>;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-terminal-rows-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build() {
  const sm = new SessionManager(dir);
  const adapter = createAdapter();
  const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
    relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
  });
  const cb = (name: string) => adapter[name] as Cb;
  const input = (sessionId: string, text: string, clientId: string) =>
    handleConsumerMessage(client, { type: 'send_input', sessionId, deviceId: 'app-1', payload: { text, clientId } });
  const stop = (sessionId: string) =>
    handleConsumerMessage(client, { type: 'abort_session', sessionId, deviceId: 'app-1', payload: {} });
  return { adapter, client, sm, cb, input, stop };
}

function rows(sm: SessionManager, sessionId: string): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
  return sm.getMessagesAfterSeq(sessionId, 0).map((m) => ({
    seq: m.seq, type: m.type, payload: (JSON.parse(m.payload) as { payload: Record<string, unknown> }).payload,
  }));
}

describe('a turn that idles without a final message (K-048)', () => {
  it('keeps its streamed words as the reply instead of dropping them', async () => {
    const { adapter, sm, cb, input } = build();
    const { sessionId } = sm.createSession('pi');
    input(sessionId, 'hi', 'cid-1');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    cb('onMessageDelta')(sessionId, { content: 'Thinking out loud' });
    cb('onIdle')(sessionId);

    const spine = rows(sm, sessionId);
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'agent_message', 'idle']);
    expect(spine[1].payload.content).toBe('Thinking out loud');
  });

  it('does not leak its draft into the next turn\'s Turn failed row', async () => {
    const { adapter, sm, cb, input } = build();
    const { sessionId } = sm.createSession('pi');
    input(sessionId, 'one', 'cid-1');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    cb('onMessageDelta')(sessionId, { content: 'OLDDRAFT' });
    cb('onIdle')(sessionId);

    input(sessionId, 'two', 'cid-2');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(2));
    cb('onError')(sessionId, { message: 'provider down' });
    cb('onIdle')(sessionId);

    const status = rows(sm, sessionId).find((r) => r.type === 'turn_status')!;
    expect(status.payload).toMatchObject({ draft: '', action: { type: 'failed' } });
  });
});

describe('Stop before any output (K-067)', () => {
  it('records a Stopped row for the running turn', async () => {
    const { adapter, sm, input, stop } = build();
    const { sessionId } = sm.createSession('pi');
    input(sessionId, 'hi', 'cid-1');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    stop(sessionId);
    await vi.waitFor(() => expect(rows(sm, sessionId).some((r) => r.type === 'idle')).toBe(true));

    const spine = rows(sm, sessionId);
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'turn_status', 'idle']);
    expect(spine[1].payload).toMatchObject({ draft: '', action: { type: 'user_abort' } });
  });

  it('adds no row when Stop reaches a turn that already ended', async () => {
    const { adapter, sm, cb, input, stop } = build();
    const { sessionId } = sm.createSession('pi');
    input(sessionId, 'hi', 'cid-1');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    cb('onMessage')(sessionId, { content: 'done' });
    cb('onIdle')(sessionId);
    stop(sessionId);
    await vi.waitFor(() => expect(adapter.abortSession as Fn).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(rows(sm, sessionId).some((r) => r.type === 'turn_status')).toBe(false);
  });
});

describe('Stop while the agent never acknowledges the first Stop (K-221)', () => {
  afterEach(() => vi.useRealTimers());

  it('a repeated Stop after the abort hangs closes the turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { adapter, sm, cb, input, stop } = build();
    const { sessionId } = sm.createSession('pi');
    input(sessionId, 'hi', 'cid-1');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    cb('onMessageDelta')(sessionId, { content: 'working' });
    (adapter.abortSession as Fn).mockImplementation(() => new Promise<void>(() => {}));
    stop(sessionId);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows(sm, sessionId).some((r) => r.type === 'idle')).toBe(false);

    vi.setSystemTime(Date.now() + 10_000);
    stop(sessionId);
    await vi.waitFor(() => expect(rows(sm, sessionId).some((r) => r.type === 'idle')).toBe(true));
    const spine = rows(sm, sessionId);
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'turn_status', 'idle']);
    expect(spine[1].payload).toMatchObject({ draft: 'working', action: { type: 'user_abort' } });
    expect(spine[2].payload.reason).toBe('aborted');
    expect(sm.getMeta(sessionId)?.state).toBe('idle');
  });

  it('a single Stop the agent never answers closes the turn after ABORT_HUNG_MS', async () => {
    const { adapter, sm, cb, input, stop } = build();
    const { sessionId } = sm.createSession('pi');
    input(sessionId, 'hi', 'cid-1');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    cb('onMessageDelta')(sessionId, { content: 'working' });
    (adapter.abortSession as Fn).mockImplementation(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    stop(sessionId);
    vi.advanceTimersByTime(ABORT_HUNG_MS - 1);
    expect(rows(sm, sessionId).some((r) => r.type === 'idle')).toBe(false);
    vi.advanceTimersByTime(1);
    const spine = rows(sm, sessionId);
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'turn_status', 'idle']);
    expect(spine[1].payload).toMatchObject({ draft: 'working', action: { type: 'user_abort' } });
    expect(sm.getMeta(sessionId)?.state).toBe('idle');
  });

  it('a quick double tap still waits for the agent', async () => {
    const { adapter, sm, input, stop } = build();
    const { sessionId } = sm.createSession('pi');
    input(sessionId, 'hi', 'cid-1');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    let release!: () => void;
    (adapter.abortSession as Fn).mockImplementation(() => new Promise<void>((done) => { release = done; }));
    stop(sessionId);
    stop(sessionId);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows(sm, sessionId).some((r) => r.type === 'idle')).toBe(false);
    release();
    await vi.waitFor(() => expect(rows(sm, sessionId).some((r) => r.type === 'idle')).toBe(true));
    expect(rows(sm, sessionId).filter((r) => r.type === 'idle')).toHaveLength(1);
    expect(adapter.abortSession as Fn).toHaveBeenCalledTimes(1);
  });
});
