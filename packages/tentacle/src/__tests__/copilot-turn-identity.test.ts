import { describe, expect, it, vi } from 'vitest';
import { CopilotAdapter } from '../adapters/copilot.js';
import { wireEvents } from '../adapters/copilot-events.js';
import { TurnTracker } from '../adapters/turn-tracker.js';

describe('Copilot relay turn identity', () => {
  it('echoes the accepted turn on terminal callbacks and reports settlement', async () => {
    const adapter = new CopilotAdapter();
    const handlers = new Map<string, Array<(e: unknown) => unknown>>();
    const session = {
      on: (type: unknown, fn?: (e: unknown) => unknown) => {
        if (typeof type === 'string' && fn) handlers.set(type, [...(handlers.get(type) ?? []), fn]);
        return () => {};
      },
      send: vi.fn(async () => {}),
    };
    const entry = { session, pendingPermissions: new Map(), pendingQuestions: new Map(), turn: new TurnTracker(adapter, 's1') };
    const internals = adapter as unknown as { sessions: Map<string, typeof entry> };
    internals.sessions.set('s1', entry);
    wireEvents(adapter, 's1', session as never);
    const fire = (type: string, data: unknown = {}) => { for (const fn of handlers.get(type) ?? []) void fn({ data }); };
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    adapter.setTurnIdentity('s1', 's1:copilot-turn');
    await adapter.sendMessage('s1', 'go');
    expect(adapter.isTurnSettled('s1')).toBe(false);

    fire('assistant.turn_start');
    fire('assistant.message', { content: 'done' });
    fire('session.idle');
    fire('session.idle'); // a duplicate idle is ignored

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'done', turnId: 's1:copilot-turn' });
    expect(onIdle).toHaveBeenCalledTimes(1);
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
    const entry = { session, pendingPermissions: new Map(), pendingQuestions: new Map(), turn: new TurnTracker(adapter, 's1') };
    entry.turn.beginTurn(); // a prompt is running
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>;
      probeRuntime: () => Promise<string>;
    };
    internals.sessions.set('s1', entry);
    internals.probeRuntime = probe;
    wireEvents(adapter, 's1', session as never);
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
