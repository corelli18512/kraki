/**
 * Copilot send recovery and turn error reporting: a send retried across a
 * runtime rebuild keeps its turn (reply + idle reach Relay), other sessions'
 * open turns end, an alive-runtime resume keeps open cards answerable, and a
 * turn's error is stamped with its own turn and awaited by idle.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const krakiHome = mkdtempSync(join(tmpdir(), 'kraki-copilot-recovery-'));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  getKrakiHome: () => krakiHome,
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { CopilotAdapter } = await import('../adapters/copilot.js');
const { wireEvents } = await import('../adapters/copilot-events.js');
const { TurnTracker } = await import('../adapters/turn-tracker.js');

type Handler = (e: unknown) => unknown;

function fakeSession(id: string) {
  const handlers = new Map<string, Handler[]>();
  return {
    sessionId: id,
    handlers,
    on: (type: unknown, fn?: Handler) => {
      if (typeof type === 'string' && fn) handlers.set(type, [...(handlers.get(type) ?? []), fn]);
      return () => {};
    },
    send: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    fire(type: string, data: unknown = {}) {
      for (const fn of handlers.get(type) ?? []) void fn({ data });
    },
  };
}

function setup() {
  const adapter = new CopilotAdapter();
  const resumed: Array<ReturnType<typeof fakeSession>> = [];
  const makeClient = () => ({
    stop: vi.fn(async () => {}),
    resumeSession: vi.fn(async (id: string) => {
      const s = fakeSession(id);
      resumed.push(s);
      return s;
    }),
  });
  const internals = adapter as unknown as {
    client: unknown;
    sessions: Map<string, { session: ReturnType<typeof fakeSession>; pendingPermissions: Map<string, unknown>; pendingQuestions: Map<string, unknown>; turn: InstanceType<typeof TurnTracker> }>;
    probeRuntime: () => Promise<string>;
    start: () => Promise<void>;
  };
  internals.client = makeClient();
  internals.start = async () => { internals.client = makeClient(); };
  const add = (sid: string) => {
    const session = fakeSession(sid);
    const entry = { session, pendingPermissions: new Map(), pendingQuestions: new Map(), turn: new TurnTracker(adapter, sid) };
    internals.sessions.set(sid, entry);
    wireEvents(adapter, sid, session as never);
    return entry;
  };
  const calls: Array<[string, string, unknown]> = [];
  for (const k of ['onMessage', 'onIdle', 'onError'] as const) {
    (adapter as unknown as Record<string, unknown>)[k] = (sid: string, e: unknown) => calls.push([k, sid, e]);
  }
  const of = (k: string, sid: string) => calls.filter(([c, s]) => c === k && s === sid).map(([, , e]) => e);
  return { adapter, internals, resumed, add, of };
}

describe('Copilot dead-runtime send recovery', () => {
  it('the retried send keeps its turn: the reply and idle reach Relay', async () => {
    const t = setup();
    const s1 = t.add('s1');
    s1.session.send.mockRejectedValueOnce(new Error('Connection is closed.'));
    t.internals.probeRuntime = async () => 'dead';
    t.adapter.setTurnIdentity('s1', 't1');
    await t.adapter.sendMessage('s1', 'hello after crash');

    const retried = t.resumed[0];
    expect(retried.send).toHaveBeenCalledWith({ prompt: 'hello after crash' });
    retried.fire('assistant.turn_start');
    retried.fire('assistant.message', { content: 'answer' });
    retried.fire('session.idle');
    expect(t.of('onMessage', 's1')).toEqual([{ content: 'answer', turnId: 't1' }]);
    expect(t.of('onIdle', 's1')).toEqual([{ turnId: 't1' }]);
  });

  it('ends the open turns of other sessions on the dead runtime', async () => {
    const t = setup();
    const s1 = t.add('s1');
    const s2 = t.add('s2');
    t.adapter.setTurnIdentity('s2', 't2');
    s2.turn.beginTurn({ captureNow: true });
    s1.session.send.mockRejectedValueOnce(new Error('Connection is closed.'));
    t.internals.probeRuntime = async () => 'dead';
    await t.adapter.sendMessage('s1', 'hello');
    expect(t.of('onError', 's2')).toEqual([expect.objectContaining({ turnId: 't2' })]);
    expect(t.of('onIdle', 's2')).toEqual([{ turnId: 't2' }]);
    expect(t.of('onIdle', 's1')).toEqual([]);
  });
});

describe('Copilot alive-runtime send recovery', () => {
  it('keeps a pending permission answerable after the resume', async () => {
    const t = setup();
    const s1 = t.add('s1');
    const resolve = vi.fn();
    s1.pendingPermissions.set('perm-1', { resolve });
    s1.session.send.mockRejectedValueOnce(new Error('transient'));
    t.internals.probeRuntime = async () => 'alive';
    await t.adapter.sendMessage('s1', 'steer', undefined, { delivery: 'steer' });
    expect(t.internals.sessions.get('s1')?.session).toBe(t.resumed[0]);
    expect(await t.adapter.respondToPermission('s1', 'perm-1', 'approve')).toBe('accepted');
    expect(resolve).toHaveBeenCalledWith({ kind: 'approve-once' });
  });
});

describe('Copilot turn error reports', () => {
  it('turn_end(error): idle waits for the probed report, stamped with its own turn', async () => {
    const t = setup();
    const s1 = t.add('s1');
    let resolveProbe!: (v: string) => void;
    t.internals.probeRuntime = () => new Promise((r) => { resolveProbe = r; });
    t.adapter.setTurnIdentity('s1', 't1');
    await t.adapter.sendMessage('s1', 'go');
    s1.session.fire('assistant.turn_start');
    s1.session.fire('assistant.turn_end', { reason: 'error', error: 'boom' });
    s1.session.fire('session.idle');
    // The next prompt is assigned before the probe returns.
    t.adapter.setTurnIdentity('s1', 't2');
    expect(t.of('onIdle', 's1')).toEqual([]);
    resolveProbe('alive');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.of('onError', 's1')).toEqual([{ message: 'boom', turnId: 't1' }]);
    expect(t.of('onIdle', 's1')).toEqual([{ turnId: 't1' }]);
  });

  it('a session.error before turn_start is the new prompt\'s, not the previous run\'s', async () => {
    const t = setup();
    const s1 = t.add('s1');
    t.adapter.setTurnIdentity('s1', 't1');
    s1.turn.beginTurn({ captureNow: true });
    s1.session.fire('session.idle'); // turn t1 done
    t.adapter.setTurnIdentity('s1', 't2');
    await t.adapter.sendMessage('s1', 'next');
    s1.session.fire('session.error', { message: 'The requested model is not supported.', statusCode: 400 });
    s1.session.fire('session.idle');
    expect(t.of('onError', 's1')).toEqual([{ message: 'The requested model is not supported.', turnId: 't2' }]);
    expect(t.of('onIdle', 's1')).toEqual([{ turnId: 't1' }, { turnId: 't2' }]);
  });
});
