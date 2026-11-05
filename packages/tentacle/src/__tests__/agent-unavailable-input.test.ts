/**
 * K-008: a prompt to a session whose agent cannot start or reopen must end
 * with a visible failure, never a silent hang (bubble stuck "Sending").
 * Real SessionManager on a temp dir, real MultiAgentAdapter routing, no sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import { handleConsumerMessage } from '../relay/consumer-messages.js';
import { handleCreateSession } from '../relay/session-commands.js';
import { MultiAgentAdapter } from '../adapters/multi.js';
import type { AgentAdapter } from '../adapters/base.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-agent-unavailable-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rows(sm: SessionManager, sessionId: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return sm.getMessagesAfterSeq(sessionId, 0).map((m) => ({
    type: m.type, payload: (JSON.parse(m.payload) as { payload: Record<string, unknown> }).payload,
  }));
}

function build(adapter: AgentAdapter) {
  const sm = new SessionManager(dir);
  const client = new RelayClient(adapter, sm, {
    relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
  });
  const sent: Array<{ type?: string; sessionId?: string; payload?: Record<string, unknown> }> = [];
  const send = client.send.bind(client);
  client.send = ((msg, ...rest) => { sent.push(msg as (typeof sent)[number]); send(msg, ...rest); }) as typeof client.send;
  return { sm, client, sent };
}

describe('K-008: input to a session whose agent cannot run', () => {
  it('Pi no longer available: the user is told and the turn closes as failed', async () => {
    const multi = new MultiAgentAdapter({ agentIds: [] });
    const { sm, client, sent } = build(multi);
    const { sessionId } = sm.createSession('pi');
    sm.markDisconnected(sessionId);
    multi.registerSessionAgent(sessionId, 'pi');

    handleConsumerMessage(client, { type: 'send_input', sessionId, deviceId: 'app-1', payload: { text: 'hi', clientId: 'cid-1' } });

    await vi.waitFor(() => expect(sent.some((m) => m.type === 'idle')).toBe(true));
    const error = sent.find((m) => m.type === 'error');
    expect(error?.sessionId).toBe(sessionId);
    expect(String(error?.payload?.message)).toContain('Pi is not available on this computer');
    const spine = rows(sm, sessionId);
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'error', 'turn_status', 'idle']);
    expect(spine[2].payload.action).toMatchObject({ type: 'failed' });
    expect(spine[3].payload.reason).toBe('failed');
    expect(sm.getInputLedgerEntry(sessionId, 'cid-1')?.status).toBe('rejected');
    // Still resumable later (e.g. once Pi is reinstalled).
    expect(sm.getMeta(sessionId)?.state).toBe('disconnected');
  });

  it('the agent fails to reopen the session: the turn closes as failed with the cause', async () => {
    const adapter = {
      generateTitle: vi.fn(async () => null),
      setSessionMode: vi.fn(),
      getSessionUsage: vi.fn(() => null),
      setSessionUsage: vi.fn(),
      registerSessionAgent: vi.fn(),
      setTurnIdentity: vi.fn(),
      isTurnSettled: vi.fn(() => false),
      sendMessage: vi.fn(async () => {}),
      resumeSession: vi.fn(async () => { throw new Error('failed to resume pi session: pi exited'); }),
      setSessionModel: vi.fn(async () => {}),
    };
    const { sm, client, sent } = build(adapter as unknown as AgentAdapter);
    const { sessionId } = sm.createSession('pi');
    sm.markDisconnected(sessionId);

    handleConsumerMessage(client, { type: 'send_input', sessionId, deviceId: 'app-1', payload: { text: 'hi', clientId: 'cid-1' } });

    await vi.waitFor(() => expect(sent.some((m) => m.type === 'idle')).toBe(true));
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    const spine = rows(sm, sessionId);
    expect(spine.map((r) => r.type)).toEqual(['user_message', 'error', 'turn_status', 'idle']);
    expect((spine[2].payload.action as { payload: { message: string } }).payload.message)
      .toBe("Pi couldn't reopen this session: failed to resume pi session: pi exited");

    // A retry after the failure starts a fresh turn and reaches the agent.
    adapter.resumeSession.mockResolvedValueOnce({ sessionId } as never);
    handleConsumerMessage(client, { type: 'send_input', sessionId, deviceId: 'app-1', payload: { text: 'again', clientId: 'cid-2' } });
    await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('create_session that fails after the session was announced reports the error on that session', async () => {
    const adapter = {
      createSession: vi.fn(async (config: { sessionId: string }) => {
        adapter.onSessionCreated?.({ sessionId: config.sessionId, agent: 'pi' });
        throw new Error('pi exited');
      }),
      onSessionCreated: undefined as undefined | ((e: { sessionId: string; agent: string }) => void),
      generateTitle: vi.fn(async () => null),
      getSessionUsage: vi.fn(() => null),
    };
    const { client, sent } = build(adapter as unknown as AgentAdapter);
    await handleCreateSession(client, { type: 'create_session', deviceId: 'app-1', payload: { requestId: 'req-1', agentId: 'pi', model: 'm' } } as never);
    const created = sent.find((m) => m.type === 'session_created');
    const error = sent.find((m) => m.type === 'error');
    expect(created?.sessionId).toBeTruthy();
    expect(error?.sessionId).toBe(created?.sessionId);
  });
});
