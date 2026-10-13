/**
 * Internal queued input (2-29, 2-30, 2-36): a prompt that reaches Tentacle
 * while an earlier prompt's turn still runs is persisted when it dispatches,
 * and an answer typed in the composer stays inside the turn that asked.
 * Real SessionManager on a temp dir, fake adapter, no sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import { handleConsumerMessage } from '../relay/consumer-messages.js';
import { resumeDisconnectedSessions } from '../relay/session-resume.js';
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
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-queued-input-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(sm = new SessionManager(dir)) {
  const adapter = createAdapter();
  const client = new RelayClient(adapter as unknown as AgentAdapter, sm, {
    relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
  });
  const cb = (name: string) => adapter[name] as Cb;
  const input = (sessionId: string, text: string, clientId: string, extra: Record<string, unknown> = {}) =>
    handleConsumerMessage(client, { type: 'send_input', sessionId, deviceId: 'app-1', payload: { text, clientId, ...extra } });
  return { adapter, client, sm, cb, input };
}

function rows(sm: SessionManager, sessionId: string): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
  return sm.getMessagesAfterSeq(sessionId, 0).map((m) => ({
    seq: m.seq, type: m.type, payload: (JSON.parse(m.payload) as { payload: Record<string, unknown> }).payload,
  }));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('a prompt queued behind a running turn (2-29, 2-36)', () => {
  it('is persisted at dispatch: the running turn keeps its Steps, artifacts and reply', async () => {
    const { adapter, sm, cb, input } = build();
    const { sessionId } = sm.createSession('claude');
    input(sessionId, 'A', 'cid-a');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    const aSeq = rows(sm, sessionId).find((r) => r.payload.clientId === 'cid-a')!.seq;
    const image = { type: 'content_ref', id: 'img-a', mimeType: 'image/png', size: 10 };
    cb('onToolStart')(sessionId, { toolName: 'show_image', args: {}, toolCallId: 'tc-img' });
    cb('onToolComplete')(sessionId, { toolName: 'show_image', result: 'shown', toolCallId: 'tc-img', attachments: [image] });

    input(sessionId, 'B', 'cid-b');
    await flush();
    // Admitted, not yet on the spine or sent to the agent.
    expect(rows(sm, sessionId).some((r) => r.payload.clientId === 'cid-b')).toBe(false);
    expect(sm.getInputLedgerEntry(sessionId, 'cid-b')?.status).toBe('pending');
    expect(sm.getMeta(sessionId)?.currentTurnStartSeq).toBe(aSeq);

    // Turn A keeps working after B arrived.
    cb('onToolStart')(sessionId, { toolName: 'bash', args: { command: 'make' }, toolCallId: 'tc-a' });
    cb('onToolComplete')(sessionId, { toolName: 'bash', result: 'ok', toolCallId: 'tc-a' });
    cb('onMessage')(sessionId, { content: 'A done' });
    cb('onIdle')(sessionId);
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(2));
    expect((adapter.sendMessage as Fn).mock.calls[1][1]).toBe('B');

    const spine = rows(sm, sessionId);
    const reply = spine.find((r) => r.type === 'agent_message')!;
    const b = spine.find((r) => r.payload.clientId === 'cid-b')!;
    // Order on the spine: A, A's reply, A's idle, then B.
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'agent_message', 'idle', 'user_message']);
    expect(reply.payload.steps).toBe(2);
    const trace = sm.readTurnTrace(sessionId, reply.seq);
    expect(trace.turnStartSeq).toBe(aSeq);
    expect(trace.entries.map((e) => (e as { payload: { toolName: string } }).payload.toolName))
      .toEqual(['show_image', 'show_image', 'bash', 'bash']);
    // A's closing idle still carries the image A showed before B arrived.
    expect(spine.find((r) => r.type === 'idle')!.payload.turnArtifacts).toEqual([image]);
    expect(sm.getMeta(sessionId)?.currentTurnStartSeq).toBe(b.seq);
    expect(sm.getInputLedgerEntry(sessionId, 'cid-b')).toMatchObject({ status: 'delivered', userSeq: b.seq });
  });

  it('a retry of the queued prompt before it dispatches neither echoes nor runs it twice', async () => {
    const { adapter, sm, cb, input } = build();
    const { sessionId } = sm.createSession('claude');
    input(sessionId, 'A', 'cid-a');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    input(sessionId, 'B', 'cid-b');
    input(sessionId, 'B', 'cid-b');
    await flush();
    cb('onIdle')(sessionId);
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(2));
    cb('onIdle')(sessionId);
    await flush();
    expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(2);
    expect(rows(sm, sessionId).filter((r) => r.payload.clientId === 'cid-b')).toHaveLength(1);
  });
});

describe('a daemon restart while a prompt is queued (2-30)', () => {
  it('fails the running turn and runs the queued prompt when the app resends it', async () => {
    const first = build();
    const { sessionId } = first.sm.createSession('claude');
    first.input(sessionId, 'A', 'cid-a');
    await vi.waitFor(() => expect(first.adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    first.input(sessionId, 'B', 'cid-b');
    await flush();

    // The daemon restarts: a new process over the same session store.
    const next = build(new SessionManager(dir));
    await resumeDisconnectedSessions(next.client);
    const afterRestart = rows(next.sm, sessionId);
    // "Kraki restarted" closes turn A, right after A's prompt.
    expect(afterRestart.map((r) => r.type)).toEqual(['user_message', 'turn_status', 'idle']);
    expect(afterRestart[1].payload.action).toMatchObject({ type: 'failed', payload: { code: 'process_lost' } });
    expect(next.sm.getInputLedgerEntry(sessionId, 'cid-b')?.status).toBe('pending');

    // The app never saw B's echo, so it resends B with the same clientId.
    next.input(sessionId, 'B', 'cid-b');
    await vi.waitFor(() => expect(next.adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    expect((next.adapter.sendMessage as Fn).mock.calls[0][1]).toBe('B');
    const spine = rows(next.sm, sessionId);
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'turn_status', 'idle', 'user_message']);
    expect(spine[3].payload.clientId).toBe('cid-b');
  });
});

describe('an answer typed in the composer (2-36)', () => {
  it('stays in the turn that asked: its Steps are not split', async () => {
    const { adapter, sm, cb, input } = build();
    const { sessionId } = sm.createSession('claude');
    input(sessionId, 'A', 'cid-a');
    await vi.waitFor(() => expect(adapter.sendMessage as Fn).toHaveBeenCalledTimes(1));
    const aSeq = rows(sm, sessionId)[0].seq;
    cb('onToolStart')(sessionId, { toolName: 'bash', args: { command: 'ls' }, toolCallId: 'tc-1' });
    cb('onToolComplete')(sessionId, { toolName: 'bash', result: 'ok', toolCallId: 'tc-1' });
    cb('onQuestionRequest')(sessionId, { id: 'q1', question: 'Which one?' });

    input(sessionId, 'the first', 'cid-ans');
    await vi.waitFor(() => expect(adapter.respondToQuestion as Fn).toHaveBeenCalledTimes(1));
    const answer = rows(sm, sessionId).find((r) => r.payload.clientId === 'cid-ans')!;
    expect(answer.payload.answerTo).toBe('q1');
    expect(sm.getMeta(sessionId)?.currentTurnStartSeq).toBe(aSeq);

    cb('onToolStart')(sessionId, { toolName: 'bash', args: { command: 'make' }, toolCallId: 'tc-2' });
    cb('onToolComplete')(sessionId, { toolName: 'bash', result: 'ok', toolCallId: 'tc-2' });
    cb('onMessage')(sessionId, { content: 'Built the first.' });
    cb('onIdle')(sessionId);

    const reply = rows(sm, sessionId).find((r) => r.type === 'agent_message' && r.payload.content === 'Built the first.')!;
    expect(reply.payload.steps).toBe(2);
    const trace = sm.readTurnTrace(sessionId, reply.seq);
    expect(trace.turnStartSeq).toBe(aSeq);
    expect(trace.entries.filter((e) => (e as { type: string }).type === 'tool_start')).toHaveLength(2);
  });
});
