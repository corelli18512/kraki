/**
 * Pi process lifecycle edges: a process exit while ask_user waits, an exit or
 * events of a process that was already replaced, failed submissions (stamped
 * with the new turn, settled before the rejection), and a watchdog failure
 * that must retire the process holding the still-pending prompt.
 */
import { describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import { turnFixture } from './helpers/turn-fixture.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function setup(opts: { open?: boolean } = { open: true }) {
  const adapter = new PiAdapter({
    cliPath: '/unused',
    promptWatchdog: { ackGraceMs: 1, intervalMs: 1, probeFailureLimit: 2, idleStallMs: 1 },
  });
  const sid = 's1';
  const proc = {
    alive: true,
    request: vi.fn().mockResolvedValue({}),
    kill: vi.fn(),
    sendRaw: vi.fn(),
    crashReason: () => undefined as string | undefined,
  };
  const session = {
    proc, cwd: '/tmp', model: 'p/m', mode: 'auto', usage: {}, lastActivity: Date.now(),
    turn: turnFixture(adapter, sid, { open: opts.open, relayTurnId: 'turn-1', eventTurnId: 'turn-1' }),
    exitObserved: false, pendingPerms: new Map<string, string>(), pendingQuestions: new Map<string, string>(),
    lastStopReason: undefined, pendingMaintenanceIdle: false, aborting: false,
  };
  const internal = adapter as unknown as {
    sessions: Map<string, typeof session>;
    handleProcessExit: (id: string, s: unknown, code: number | null) => void;
  };
  internal.sessions.set(sid, session);
  const calls: Array<[string, unknown]> = [];
  for (const k of ['onError', 'onIdle', 'onMessage', 'onSessionEvicted', 'onPermissionAutoResolved'] as const) {
    (adapter as unknown as Record<string, unknown>)[k] = (...args: unknown[]) => calls.push([k, args.slice(1)]);
  }
  const of = (k: string) => calls.filter(([c]) => c === k).map(([, a]) => a);
  const exit = (s: unknown = session, code: number | null = 1) => internal.handleProcessExit(sid, s, code);
  return { adapter, sid, proc, session, internal, of, exit };
}

describe('pi process exit', () => {
  it('while ask_user waits: no failed turn; the question stays recoverable', () => {
    const t = setup();
    t.session.pendingQuestions.set('q1', 'q1');
    t.exit();
    expect(t.of('onError')).toEqual([]);
    expect(t.of('onIdle')).toEqual([]);
    expect(t.of('onSessionEvicted')).toHaveLength(1);
    expect(t.session.turn.isSettled).toBe(true);
  });

  it('mid-turn without a question still fails the turn', () => {
    const t = setup();
    t.exit();
    expect(t.of('onError')).toEqual([[{ message: 'Pi stopped unexpectedly (exit code 1)', turnId: 'turn-1' }]]);
    expect(t.of('onIdle')).toEqual([[{ turnId: 'turn-1' }]]);
  });

  it('of a process already replaced leaves the replacement alone', () => {
    const t = setup();
    const old = t.session;
    const replacement = { ...old, turn: turnFixture(t.adapter, t.sid, { open: true, relayTurnId: 'turn-2', eventTurnId: 'turn-2' }), pendingPerms: new Map([['p2', 'p2']]) };
    t.internal.sessions.set(t.sid, replacement);
    t.exit(old);
    expect(t.of('onSessionEvicted')).toEqual([]);
    expect(t.of('onPermissionAutoResolved')).toEqual([]);
    expect(t.of('onError')).toEqual([]);
    expect(t.of('onIdle')).toEqual([]);
    expect(replacement.pendingPerms.has('p2')).toBe(true);
    expect(replacement.turn.isSettled).toBe(false);
  });
});

describe('pi queued events of a replaced process', () => {
  it('are dropped instead of mutating the replacement', async () => {
    const adapter = new PiAdapter({ cliPath: '/unused' });
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    // No files: the sidecar and the tools extension are not under test.
    Object.assign(adapter, { persistMeta: () => {}, ensureToolsExtension: () => '/unused/kraki-tools.ts' });
    const spawn = (adapter as unknown as { spawn: (...a: unknown[]) => { proc: { onEvent?: (e: unknown) => void; kill: () => void } } }).spawn.bind(adapter);
    const { PiRpcProcess } = await import('../adapters/pi-rpc.js');
    const start = vi.spyOn(PiRpcProcess.prototype, 'start').mockImplementation(() => {});
    try {
      const first = spawn('s1', '/tmp', 'p/m', 'safe');
      spawn('s1', '/tmp', 'p/m', 'safe');
      first.proc.onEvent?.({ type: 'extension_ui_request', id: 'p-old', method: 'confirm', title: 'kraki-dialog:bash', message: '{"command":"rm x"}' });
      await new Promise((r) => setTimeout(r, 0));
      expect(onPermissionRequest).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });
});

describe('pi failed submissions', () => {
  it('a prompt rejected before agent_start reports error and idle on the NEW turn', async () => {
    const t = setup({ open: false });
    t.adapter.setTurnIdentity(t.sid, 'turn-2');
    t.proc.request.mockRejectedValueOnce(new Error('No API key for provider'));
    await expect(t.adapter.sendMessage(t.sid, 'hello')).rejects.toThrow('No API key');
    expect(t.of('onError')).toEqual([[{ message: 'No API key for provider', turnId: 'turn-2' }]]);
    expect(t.of('onIdle')).toEqual([[{ turnId: 'turn-2' }]]);
    // Late events of the previous run keep that run's id.
    expect(t.session.turn.event()).toEqual({ turnId: 'turn-1' });
  });

  it.each(['follow_up', 'steer'] as const)('a rejected %s that opened a turn settles it before rethrowing', async (delivery) => {
    const t = setup({ open: false });
    t.adapter.setTurnIdentity(t.sid, 'turn-2');
    t.proc.request.mockRejectedValueOnce(new Error('rejected'));
    await expect(t.adapter.sendMessage(t.sid, 'more', undefined, { delivery })).rejects.toThrow('rejected');
    expect(t.session.turn.isSettled).toBe(true);
    expect(t.of('onIdle')).toEqual([[{ turnId: 'turn-2' }]]);
  });

  it('a failed retry after "already processing" settles the turn before rethrowing', async () => {
    const t = setup({ open: false });
    t.adapter.setTurnIdentity(t.sid, 'turn-2');
    t.proc.request.mockImplementation(async (type: string) => {
      if (type === 'prompt') throw new Error('Agent is already processing');
      return {};
    });
    await expect(t.adapter.sendMessage(t.sid, 'hello')).rejects.toThrow('already processing');
    expect(t.session.turn.isSettled).toBe(true);
    expect(t.of('onIdle')).toEqual([[{ turnId: 'turn-2' }]]);
  });

  it('a watchdog failure retires the process so the pending prompt cannot run later', async () => {
    const t = setup({ open: false });
    t.adapter.setTurnIdentity(t.sid, 'turn-2');
    t.proc.request.mockImplementation((type: string) => (type === 'prompt'
      ? new Promise(() => {}) // never ACKed
      : Promise.resolve({ isStreaming: false, isCompacting: false })));
    await expect(t.adapter.sendMessage(t.sid, 'hello')).rejects.toThrow('neither streaming nor compaction');
    expect(t.proc.kill).toHaveBeenCalledOnce();
    expect(t.of('onIdle')).toEqual([[{ turnId: 'turn-2' }]]);
  });

  it('a prompt rejected by pi itself does not kill the process', async () => {
    const t = setup({ open: false });
    t.proc.request.mockRejectedValueOnce(new Error('No model selected'));
    await expect(t.adapter.sendMessage(t.sid, 'hello')).rejects.toThrow('No model');
    expect(t.proc.kill).not.toHaveBeenCalled();
  });
});
