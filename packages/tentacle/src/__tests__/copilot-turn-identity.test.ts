import { describe, expect, it, vi } from 'vitest';
import { CopilotAdapter } from '../adapters/copilot.js';

describe('Copilot relay turn identity', () => {
  it('echoes the accepted turn on terminal callbacks and reports settlement', () => {
    const adapter = new CopilotAdapter();
    const entry = {
      session: {},
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      relayTurnId: undefined as string | undefined,
      turnSettled: false,
    };
    (adapter as unknown as { sessions: Map<string, typeof entry> }).sessions.set('s1', entry);
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    adapter.setTurnIdentity('s1', 's1:copilot-turn');

    (adapter as unknown as { emitMessage: (sessionId: string, content: string) => void })
      .emitMessage('s1', 'done');
    (adapter as unknown as { emitIdle: (sessionId: string) => void })
      .emitIdle('s1');

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'done', turnId: 's1:copilot-turn' });
    expect(onIdle).toHaveBeenCalledWith('s1', { turnId: 's1:copilot-turn' });
    expect(adapter.isTurnSettled('s1')).toBe(true);
  });
});

describe('Copilot session.error before idle (Windows E2E finding)', () => {
  function wired(probe: () => Promise<'alive' | 'auth_error' | 'dead'>) {
    const adapter = new CopilotAdapter();
    const handlers = new Map<string, Array<(e: unknown) => unknown>>();
    const session = {
      on: (type: unknown, fn?: (e: unknown) => unknown) => {
        if (typeof type === 'string' && fn) handlers.set(type, [...(handlers.get(type) ?? []), fn]);
        return () => {};
      },
    };
    const entry = { session, pendingPermissions: new Map(), pendingQuestions: new Map(), relayTurnId: undefined, turnSettled: false };
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>;
      wireEvents: (id: string, s: unknown) => void;
      probeRuntime: () => Promise<string>;
    };
    internals.sessions.set('s1', entry);
    internals.probeRuntime = probe;
    internals.wireEvents('s1', session);
    const order: string[] = [];
    adapter.onError = (_id, e) => { order.push(`error:${e.message}`); };
    adapter.onIdle = () => { order.push('idle'); };
    const fire = (type: string, data: unknown = {}) => { for (const fn of handlers.get(type) ?? []) void fn({ data }); };
    return { fire, order };
  }

  it('reports a request error (e.g. unsupported model) before the turn ends', async () => {
    const { fire, order } = wired(async () => 'alive');
    fire('session.error', { message: 'The requested model is not supported.', statusCode: 400 });
    fire('session.idle');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['error:The requested model is not supported.', 'idle']);
  });

  it('waits for the sign-in probe before ending the turn', async () => {
    let resolveProbe!: (v: 'auth_error') => void;
    const { fire, order } = wired(() => new Promise((r) => { resolveProbe = r; }));
    fire('session.error', { message: 'Unauthorized', statusCode: 401 });
    fire('session.idle');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]);
    resolveProbe('auth_error');
    await new Promise((r) => setTimeout(r, 0));
    expect(order[0]).toMatch(/^error:GitHub credential expired/);
    expect(order[1]).toBe('idle');
  });
});
