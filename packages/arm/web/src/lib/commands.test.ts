import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../hooks/useStore';
import * as commands from './commands';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

beforeEach(() => {
  useStore.getState().reset();
});

describe('setSessionMode', () => {
  it('sends set_session_mode message', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'execute', send);
    expect(send).toHaveBeenCalledWith({
      type: 'set_session_mode',
      sessionId: 'sess-1',
      payload: { mode: 'execute' },
    });
  });

  it('updates store session mode', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'execute', send);
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('execute');
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

  it('restores auto mode from replayed message', () => {
    seedSession('sess-1');
    handleDataMessage(makeModeSetMsg('sess-1', 'execute') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('execute');
  });

  it('restores discuss mode (clears entry)', () => {
    seedSession('sess-1');
    useStore.getState().setSessionMode('sess-1', 'execute');
    handleDataMessage(makeModeSetMsg('sess-1', 'discuss') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
  });

  it('works for live (non-replay) messages', () => {
    seedSession('sess-2');
    handleDataMessage(makeModeSetMsg('sess-2', 'execute') as InnerMessage, {
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-2')).toBe('execute');
  });
});
