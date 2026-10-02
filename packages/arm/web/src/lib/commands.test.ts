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
