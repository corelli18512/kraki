/**
 * Importing a Copilot CLI session (handleImportSession) creates and routes the
 * session through the Copilot agent, not whichever agent registered first;
 * without Copilot it is imported read-only.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AgentAdapter } from '../adapters/base.js';
import { MultiAgentAdapter } from '../adapters/multi.js';
import { handleImportSession } from '../relay/session-commands.js';
import type { RelayClient } from '../relay-client.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

class FakeAdapter extends AgentAdapter {
  createSession = vi.fn(async (config: { sessionId?: string }) => ({ sessionId: config.sessionId ?? 'x' }));
  sendMessage = vi.fn(async () => {});
  constructor(readonly name: string) { super(); }
  async start() {} async stop() {}
  async resumeSession(id: string) { return { sessionId: id }; }
  async respondToPermission() { return 'accepted' as const; }
  async respondToQuestion() { return 'accepted' as const; }
  async killSession() {} async listSessions() { return []; }
}

function setup(order: string[]) {
  const multi = new MultiAgentAdapter({});
  const fakes = new Map(order.map((id) => [id, new FakeAdapter(id)]));
  const internals = multi as unknown as { adapters: Map<string, AgentAdapter> };
  for (const [id, a] of fakes) internals.adapters.set(id, a);
  const send = vi.fn();
  const client = {
    adapter: multi,
    send,
    pendingRequestIds: new Map(),
    authInfo: { deviceId: 'dev' },
    broadcastSessionList: vi.fn(),
    sessionManager: {
      getLink: () => undefined,
      createSession: vi.fn(),
      updateMeta: vi.fn(),
      appendMessagesBatch: () => 0,
      addLink: vi.fn(),
      markIdle: vi.fn(),
    },
  } as unknown as RelayClient;
  // A session id no Copilot install has: the backfill is empty.
  const localSessionId = `import-test-${randomUUID()}`;
  const msg = { type: 'import_session', payload: { requestId: 'r1', localSessionId, meta: { cwd: '/repo', source: 'copilot-cli' } } };
  return { multi, fakes, client, send, localSessionId, msg };
}

describe('Copilot session import', () => {
  it.each([[['claude', 'copilot']], [['copilot', 'claude']]])('creates the session on Copilot (adapter order %j) and routes the next input there', async (order) => {
    const t = setup(order);
    await handleImportSession(t.client, t.msg as never);
    expect(t.fakes.get('copilot')?.createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: t.localSessionId, agentId: 'copilot' }));
    expect(t.fakes.get('claude')?.createSession).not.toHaveBeenCalled();
    await t.multi.sendMessage(t.localSessionId, 'next prompt');
    expect(t.fakes.get('copilot')?.sendMessage).toHaveBeenCalled();
    expect(t.fakes.get('claude')?.sendMessage).not.toHaveBeenCalled();
  });

  it('without Copilot the session is imported read-only (not on another agent)', async () => {
    const t = setup(['claude']);
    await handleImportSession(t.client, t.msg as never);
    expect(t.fakes.get('claude')?.createSession).not.toHaveBeenCalled();
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', payload: expect.objectContaining({ message: expect.stringContaining('history is browsable') }) }));
  });
});
