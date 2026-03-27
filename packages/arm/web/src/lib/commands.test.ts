import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../hooks/useStore';
import * as commands from './commands';
import { handleDataMessage } from './message-router';
import type { PendingPermission } from '../types/store';
import type { PermissionRequest } from '@kraki/protocol';

beforeEach(() => {
  useStore.getState().reset();
});

describe('setSessionMode', () => {
  it('sends set_session_mode message', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'auto', send);
    expect(send).toHaveBeenCalledWith({
      type: 'set_session_mode',
      sessionId: 'sess-1',
      payload: { mode: 'auto' },
    });
  });

  it('updates store session mode', () => {
    const send = vi.fn();
    commands.setSessionMode('sess-1', 'auto', send);
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('auto');
  });

  it('auto-approves pending permissions when switching to auto', () => {
    const perm1: PendingPermission = {
      id: 'perm-1',
      sessionId: 'sess-1',
      toolName: 'shell',
      args: { command: 'ls' },
      description: 'List files',
      timestamp: new Date().toISOString(),
    };
    const perm2: PendingPermission = {
      id: 'perm-2',
      sessionId: 'sess-1',
      toolName: 'write_file',
      args: { path: '/tmp/test' },
      description: 'Write file',
      timestamp: new Date().toISOString(),
    };
    useStore.getState().addPermission(perm1);
    useStore.getState().addPermission(perm2);

    const send = vi.fn();
    commands.setSessionMode('sess-1', 'auto', send);

    // Should send set_session_mode + approve for each pending permission
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledWith({
      type: 'approve',
      sessionId: 'sess-1',
      payload: { permissionId: 'perm-1' },
    });
    expect(send).toHaveBeenCalledWith({
      type: 'approve',
      sessionId: 'sess-1',
      payload: { permissionId: 'perm-2' },
    });

    // Permissions should be removed from store
    expect(useStore.getState().pendingPermissions.size).toBe(0);
  });

  it('does not auto-approve permissions from other sessions', () => {
    const permOther: PendingPermission = {
      id: 'perm-other',
      sessionId: 'sess-2',
      toolName: 'shell',
      args: { command: 'ls' },
      description: 'List files',
      timestamp: new Date().toISOString(),
    };
    useStore.getState().addPermission(permOther);

    const send = vi.fn();
    commands.setSessionMode('sess-1', 'auto', send);

    // Only set_session_mode message, no approve
    expect(send).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingPermissions.size).toBe(1);
  });

  it('does not auto-approve when switching to ask mode', () => {
    const perm: PendingPermission = {
      id: 'perm-1',
      sessionId: 'sess-1',
      toolName: 'shell',
      args: { command: 'ls' },
      description: 'List files',
      timestamp: new Date().toISOString(),
    };
    useStore.getState().addPermission(perm);

    const send = vi.fn();
    commands.setSessionMode('sess-1', 'ask', send);

    // Only set_session_mode message
    expect(send).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingPermissions.size).toBe(1);
  });
});

describe('handleDataMessage auto-approve in auto mode', () => {
  const makePermissionMsg = (id: string, sessionId: string): PermissionRequest => ({
    type: 'permission',
    deviceId: 'dev-tentacle',
    seq: 1,
    timestamp: new Date().toISOString(),
    sessionId,
    payload: {
      id,
      toolName: 'shell',
      args: { command: 'npm test' },
      description: 'Run npm test',
    },
  });

  const cmdState = new commands.CommandState();

  it('adds permission as pending in auto mode (auto-approve moved to tentacle)', () => {
    const sendEncrypted = vi.fn();
    useStore.getState().setSessionMode('sess-1', 'auto');

    handleDataMessage(makePermissionMsg('perm-1', 'sess-1'), {
      replayingSessions: new Set(),
      cmdState,
      sendEncrypted,
    });

    // Auto-approve is now handled by tentacle, not the frontend
    expect(useStore.getState().pendingPermissions.size).toBe(1);
    expect(sendEncrypted).not.toHaveBeenCalled();
  });

  it('adds permission as pending when session is in ask mode', () => {
    const sendEncrypted = vi.fn();

    handleDataMessage(makePermissionMsg('perm-2', 'sess-1'), {
      replayingSessions: new Set(),
      cmdState,
      sendEncrypted,
    });

    expect(useStore.getState().pendingPermissions.size).toBe(1);
    expect(sendEncrypted).not.toHaveBeenCalled();
  });

  it('does not auto-approve during replay even in auto mode', () => {
    const sendEncrypted = vi.fn();
    useStore.getState().setSessionMode('sess-1', 'auto');

    handleDataMessage(makePermissionMsg('perm-3', 'sess-1'), {
      replayingSessions: new Set(["test-session"]),
      cmdState,
      sendEncrypted,
    });

    // During replay, permissions are added as pending (approve should follow in replay)
    expect(useStore.getState().pendingPermissions.size).toBe(1);
    expect(sendEncrypted).not.toHaveBeenCalled();
  });
});

describe('handleDataMessage session_mode_set', () => {
  const cmdState = new commands.CommandState();

  const makeModeSetMsg = (sessionId: string, mode: 'ask' | 'auto') => ({
    type: 'session_mode_set' as const,
    deviceId: 'dev-tentacle',
    seq: 10,
    timestamp: new Date().toISOString(),
    sessionId,
    payload: { mode },
  });

  it('restores auto mode from replayed message', () => {
    handleDataMessage(makeModeSetMsg('sess-1', 'auto') as any, {
      replayingSessions: new Set(["test-session"]),
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-1')).toBe('auto');
  });

  it('restores ask mode (clears entry)', () => {
    useStore.getState().setSessionMode('sess-1', 'auto');
    handleDataMessage(makeModeSetMsg('sess-1', 'ask') as any, {
      replayingSessions: new Set(["test-session"]),
      cmdState,
    });
    expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
  });

  it('works for live (non-replay) messages', () => {
    handleDataMessage(makeModeSetMsg('sess-2', 'auto') as any, {
      replayingSessions: new Set(),
      cmdState,
    });
    expect(useStore.getState().sessionModes.get('sess-2')).toBe('auto');
  });
});
