import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../hooks/useStore';
import * as commands from './commands';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

beforeEach(() => {
  useStore.getState().reset();
});

describe('setSessionMode', () => {
  it('sends auto under its legacy wire name during the transition release', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'auto', send);
    expect(send).toHaveBeenCalledWith({
      type: 'set_session_mode',
      sessionId: 'sess-1',
      payload: { mode: 'execute' },
    });
    commands.setSessionMode('sess-1', 'safe', send);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { mode: 'safe' } }));
  });

  it('updates store session mode', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'safe', send);
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('safe');
  });

});

describe('handleDataMessage session_mode_set', () => {
  const cmdState = new commands.CommandState();

  const makeModeSetMsg = (sessionId: string, mode: string) => ({
    type: 'session_mode_set' as const,
    deviceId: 'dev-tentacle',
    seq: 10,
    timestamp: new Date().toISOString(),
    sessionId,
    payload: { mode },
  });

  const seedSession = (id: string) => {
    useStore.getState().upsertSession({
      id, deviceId: 'dev-tentacle', deviceName: 'test', agent: 'test', state: 'active', messageCount: 0,
    });
  };

  it('restores safe mode from a replayed message', () => {
    seedSession('sess-1');
    handleDataMessage(makeModeSetMsg('sess-1', 'safe') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('safe');
  });

  it.each(['execute', 'auto'])('reads %s as auto (clears the entry)', (wire) => {
    seedSession('sess-1');
    useStore.getState().setSessionMode('sess-1', 'safe');
    handleDataMessage(makeModeSetMsg('sess-1', wire) as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
  });

  it('works for live (non-replay) messages', () => {
    seedSession('sess-2');
    handleDataMessage(makeModeSetMsg('sess-2', 'delegate') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-2')).toBe('delegate');
  });
});

describe('deny with a reason', () => {
  it('sends the reason with the deny', async () => {
    const { deny } = await import('./commands');
    const sent: Record<string, unknown>[] = [];
    deny('p1', 's1', (m) => sent.push(m), '  keep the file ');
    deny('p2', 's1', (m) => sent.push(m));
    expect(sent[0]).toEqual({ type: 'deny', sessionId: 's1', payload: { permissionId: 'p1', reason: 'keep the file' } });
    expect(sent[1]).toEqual({ type: 'deny', sessionId: 's1', payload: { permissionId: 'p2' } });
  });
});

describe('forkSession', () => {
  it('records the source of each fork request, cleared with the request', () => {
    const state = new commands.CommandState();
    const sent: Array<Record<string, unknown>> = [];
    commands.forkSession('src-1', (m) => sent.push(m), state);
    const requestId = (sent[0]!.payload as { requestId: string }).requestId;
    expect(state.forkSources.get(requestId)).toBe('src-1');
    state.clearRequest(requestId);
    expect(state.forkSources.has(requestId)).toBe(false);
  });
});

describe('rapid pin toggles under latency (K-207)', () => {
  const echo = (sessionId: string, pinned: boolean) => handleDataMessage({
    type: 'session_pinned', deviceId: 'dev-tentacle', seq: 1, timestamp: new Date().toISOString(), sessionId, payload: { pinned },
  } as unknown as InnerMessage, { cmdState: new commands.CommandState() });
  const pinnedNow = () => useStore.getState().pinnedSessions.has('sess-p');

  beforeEach(() => {
    commands.resetPendingPins();
    useStore.getState().upsertSession({ id: 'sess-p', deviceId: 'dev-tentacle', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 0 });
  });

  it('ignores the echoes of superseded pin requests', () => {
    const send = vi.fn();
    commands.pinSession('sess-p', true, send);
    commands.pinSession('sess-p', false, send);
    commands.pinSession('sess-p', true, send);
    expect(pinnedNow()).toBe(true);
    echo('sess-p', true);
    expect(pinnedNow()).toBe(true);
    echo('sess-p', false); // stale: would make the row jump out of Pinned
    expect(pinnedNow()).toBe(true);
    echo('sess-p', true);
    expect(pinnedNow()).toBe(true);
    // Settled: a pin change from another device applies again.
    echo('sess-p', false);
    expect(pinnedNow()).toBe(false);
  });

  it('keeps the requested pin while a stale session list is in flight', () => {
    commands.pinSession('sess-p', true, vi.fn());
    expect(commands.pendingPin('sess-p')).toBe(true);
    echo('sess-p', true);
    expect(commands.pendingPin('sess-p')).toBeUndefined();
  });

  it('applies echoes again after a lost echo times out', () => {
    vi.useFakeTimers();
    try {
      commands.pinSession('sess-p', true, vi.fn());
      vi.advanceTimersByTime(commands.PIN_ECHO_TIMEOUT_MS + 1);
      expect(commands.pendingPin('sess-p')).toBeUndefined();
      echo('sess-p', false);
      expect(pinnedNow()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
