import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../hooks/useStore';
import type { SessionSummary, DeviceSummary } from '@kraki/protocol';
import type { ChatMessage } from '../types/store';

// Helper to reset store before each test
beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
});

// --- Fixtures ---

const mockSession: SessionSummary = {
  id: 'sess-1',
  deviceId: 'dev-1',
  deviceName: 'MacBook',
  agent: 'copilot',
  model: 'gpt-4o',
  state: 'active',
  messageCount: 5,
};

const mockSession2: SessionSummary = {
  id: 'sess-2',
  deviceId: 'dev-2',
  deviceName: 'Server',
  agent: 'claude',
  state: 'idle',
  messageCount: 2,
};

const mockDevice: DeviceSummary = {
  id: 'dev-1',
  name: 'MacBook Pro',
  role: 'tentacle',
  kind: 'desktop',
  online: true,
};

const mockDevice2: DeviceSummary = {
  id: 'dev-2',
  name: 'CI Server',
  role: 'tentacle',
  kind: 'server',
  online: true,
};

const mockMessage: ChatMessage = {
  type: 'agent_message',
  deviceId: 'dev-1',
  seq: 1,
  timestamp: new Date().toISOString(),
  sessionId: 'sess-1',
  payload: { content: 'Hello from agent' },
} as ChatMessage;

const mockPermissionAction = {
  type: 'permission' as const,
  payload: {
    id: 'perm-1',
    toolName: 'shell',
    args: { command: 'ls' },
    description: 'List files',
  },
};

const mockToolAction = {
  type: 'tool_start' as const,
  payload: { toolName: 'bash', headline: 'ls', toolCallId: 't1' },
};

// --- Tests ---

describe('useStore', () => {
  describe('connection state', () => {
    it('initializes with awaiting_login when no credentials', () => {
      const state = useStore.getState();
      expect(state.status).toBe('awaiting_login');
      expect(state.deviceId).toBeNull();
    });

    it('setStatus updates connection status', () => {
      useStore.getState().setStatus('connecting');
      expect(useStore.getState().status).toBe('connecting');

      useStore.getState().setStatus('connected');
      expect(useStore.getState().status).toBe('connected');

      useStore.getState().setStatus('error');
      expect(useStore.getState().status).toBe('error');
    });

    it('setAuth stores deviceId', () => {
      useStore.getState().setAuth('dev-web-1');
      const state = useStore.getState();
      expect(state.deviceId).toBe('dev-web-1');
    });

    it('setReconnectState stores reconnect metadata', () => {
      useStore.getState().setReconnectState(5, 30000);
      const state = useStore.getState();
      expect(state.reconnectAttempts).toBe(5);
      expect(state.nextReconnectDelayMs).toBe(30000);
    });
  });

  describe('sessions', () => {
    it('setSessions stores sessions by id', () => {
      useStore.getState().setSessions([mockSession, mockSession2]);
      const sessions = useStore.getState().sessions;
      expect(sessions.size).toBe(2);
      expect(sessions.get('sess-1')).toEqual(mockSession);
      expect(sessions.get('sess-2')).toEqual(mockSession2);
    });

    it('setSessions projects Tentacle cursors and removes stale session badges', () => {
      useStore.setState({ unreadCount: new Map([['stale', 1]]) });
      useStore.getState().setSessions([
        { ...mockSession, lastSeq: 10, readSeq: 9 },
        { ...mockSession2, lastSeq: 7, readSeq: 7 },
      ]);

      expect(useStore.getState().unreadCount.get('sess-1')).toBe(1);
      expect(useStore.getState().unreadCount.has('sess-2')).toBe(false);
      expect(useStore.getState().unreadCount.has('stale')).toBe(false);
    });

    it('upsertSession accepts a lower authoritative readSeq', () => {
      useStore.getState().upsertSession({ ...mockSession, lastSeq: 10, readSeq: 10 });
      useStore.getState().upsertSession({ ...mockSession, lastSeq: 10, readSeq: 9 });

      expect(useStore.getState().sessions.get('sess-1')?.readSeq).toBe(9);
      expect(useStore.getState().unreadCount.get('sess-1')).toBe(1);
    });

    it('upsertSession adds a new session', () => {
      useStore.getState().upsertSession(mockSession);
      expect(useStore.getState().sessions.size).toBe(1);
      expect(useStore.getState().sessions.get('sess-1')).toEqual(mockSession);
    });

    it('upsertSession updates an existing session', () => {
      useStore.getState().setSessions([mockSession]);
      const updated = { ...mockSession, state: 'ended' as const, messageCount: 10 };
      useStore.getState().upsertSession(updated);
      expect(useStore.getState().sessions.get('sess-1')?.state).toBe('ended');
      expect(useStore.getState().sessions.get('sess-1')?.messageCount).toBe(10);
    });

    it('upsertSession preserves other sessions', () => {
      useStore.getState().setSessions([mockSession, mockSession2]);
      const updated = { ...mockSession, state: 'idle' as const };
      useStore.getState().upsertSession(updated);
      expect(useStore.getState().sessions.size).toBe(2);
      expect(useStore.getState().sessions.get('sess-2')).toEqual(mockSession2);
    });
  });

  describe('devices', () => {
    it('setDevices stores devices by id', () => {
      useStore.getState().setDevices([mockDevice, mockDevice2]);
      const devices = useStore.getState().devices;
      expect(devices.size).toBe(2);
      expect(devices.get('dev-1')).toEqual(mockDevice);
    });

    it('upsertDevice adds a new device', () => {
      useStore.getState().upsertDevice(mockDevice);
      expect(useStore.getState().devices.size).toBe(1);
    });

    it('removeDevice removes a device', () => {
      useStore.getState().setDevices([mockDevice, mockDevice2]);
      useStore.getState().removeDevice('dev-1');
      expect(useStore.getState().devices.size).toBe(1);
      expect(useStore.getState().devices.has('dev-1')).toBe(false);
      expect(useStore.getState().devices.has('dev-2')).toBe(true);
    });

    it('setDeviceOnline toggles online status', () => {
      useStore.getState().setDevices([mockDevice]);
      useStore.getState().setDeviceOnline('dev-1', false);
      expect(useStore.getState().devices.get('dev-1')?.online).toBe(false);

      useStore.getState().setDeviceOnline('dev-1', true);
      expect(useStore.getState().devices.get('dev-1')?.online).toBe(true);
    });

    it('setDeviceOnline is no-op for unknown device', () => {
      useStore.getState().setDevices([mockDevice]);
      useStore.getState().setDeviceOnline('dev-unknown', false);
      expect(useStore.getState().devices.size).toBe(1);
      expect(useStore.getState().devices.get('dev-1')?.online).toBe(true);
    });
  });

  describe('messages', () => {
    it('appendMessage adds message to session', () => {
      useStore.getState().appendMessage('sess-1', mockMessage);
      const msgs = useStore.getState().messages.get('sess-1');
      expect(msgs).toHaveLength(1);
      expect(msgs![0]).toEqual(mockMessage);
    });

    it('appendMessage creates new array for new session', () => {
      expect(useStore.getState().messages.has('sess-new')).toBe(false);
      useStore.getState().appendMessage('sess-new', mockMessage);
      expect(useStore.getState().messages.has('sess-new')).toBe(true);
      expect(useStore.getState().messages.get('sess-new')).toHaveLength(1);
    });

    it('appendMessage appends to existing messages', () => {
      useStore.getState().appendMessage('sess-1', mockMessage);
      const msg2 = { ...mockMessage, seq: 2 };
      useStore.getState().appendMessage('sess-1', msg2);
      expect(useStore.getState().messages.get('sess-1')).toHaveLength(2);
    });

    it('messages for different sessions are independent', () => {
      useStore.getState().appendMessage('sess-1', mockMessage);
      useStore.getState().appendMessage('sess-2', { ...mockMessage, sessionId: 'sess-2' } as ChatMessage);
      expect(useStore.getState().messages.get('sess-1')).toHaveLength(1);
      expect(useStore.getState().messages.get('sess-2')).toHaveLength(1);
    });

    it('appendMessage dedups by [type, seq] when seq > 0 (defends against relay re-broadcasts)', () => {
      useStore.getState().appendMessage('sess-1', mockMessage);
      const updated = { ...mockMessage, payload: { content: 'updated content' } } as ChatMessage;
      useStore.getState().appendMessage('sess-1', updated);
      const msgs = useStore.getState().messages.get('sess-1');
      expect(msgs).toHaveLength(1);
      expect((msgs![0] as typeof mockMessage).payload.content).toBe('updated content');
    });

    it('range batches replace a stale transient row at the same session seq', () => {
      useStore.getState().appendMessage('sess-1', {
        type: 'active',
        deviceId: 'dev-1',
        seq: 495,
        timestamp: '',
        sessionId: 'sess-1',
        payload: {},
      } as ChatMessage);

      useStore.getState().prependMessages('sess-1', [{
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 495,
        timestamp: '',
        sessionId: 'sess-1',
        payload: { content: 'recovered reply' },
      } as ChatMessage]);

      const messages = useStore.getState().messages.get('sess-1');
      expect(messages).toHaveLength(1);
      expect(messages?.[0].type).toBe('agent_message');
      expect(messages?.[0] && 'payload' in messages[0] ? messages[0].payload : undefined).toMatchObject({
        content: 'recovered reply',
      });
    });

    it('appendMessage does NOT dedup pending_input (seq=0)', () => {
      const pendingA = {
        type: 'pending_input' as const,
        id: 'cid-a',
        clientId: 'cid-a',
        sessionId: 'sess-1',
        text: 'first',
        timestamp: new Date().toISOString(),
      };
      const pendingB = { ...pendingA, id: 'cid-b', clientId: 'cid-b', text: 'second' };
      useStore.getState().appendMessage('sess-1', pendingA);
      useStore.getState().appendMessage('sess-1', pendingB);
      const msgs = useStore.getState().messages.get('sess-1');
      expect(msgs).toHaveLength(2);
    });
  });

  describe('server-owned cards', () => {
    it('applyCardMessage accumulates content', () => {
      useStore.getState().applyCardMessage('sess-1', 'Hello ');
      useStore.getState().applyCardMessage('sess-1', 'world');
      expect(useStore.getState().cards.get('sess-1')?.text).toBe('Hello world');
    });

    it('applyCardMessage reset replaces content', () => {
      useStore.getState().applyCardMessage('sess-1', 'old');
      useStore.getState().applyCardMessage('sess-1', 'new', true);
      expect(useStore.getState().cards.get('sess-1')?.text).toBe('new');
    });

    it('setCardAction preserves text', () => {
      useStore.getState().applyCardMessage('sess-1', 'working');
      useStore.getState().setCardAction('sess-1', mockPermissionAction);
      const card = useStore.getState().cards.get('sess-1');
      expect(card?.text).toBe('working');
      expect(card?.action).toEqual(mockPermissionAction);
    });

    it('setCardAction creates a card if needed', () => {
      useStore.getState().setCardAction('sess-new', mockToolAction);
      expect(useStore.getState().cards.get('sess-new')).toEqual({ text: '', action: mockToolAction });
    });

    it('clearCard removes a card', () => {
      useStore.getState().applyCardMessage('sess-1', 'some content');
      useStore.getState().clearCard('sess-1');
      expect(useStore.getState().cards.has('sess-1')).toBe(false);
    });

    it('clearCard is safe for non-existing session', () => {
      useStore.getState().clearCard('sess-nonexistent');
      expect(useStore.getState().cards.has('sess-nonexistent')).toBe(false);
    });

    it('runtime status is independent from the card and cleared with session removal', () => {
      useStore.getState().setSessions([mockSession]);
      useStore.getState().setCardAction('sess-1', mockToolAction);
      useStore.getState().setRuntimeStatus('sess-1', { status: 'compacting', reason: 'overflow' });
      expect(useStore.getState().runtimeStatuses.get('sess-1')).toEqual({
        status: 'compacting', reason: 'overflow',
      });
      expect(useStore.getState().cards.get('sess-1')?.action).toEqual(mockToolAction);

      useStore.getState().removeSession('sess-1');
      expect(useStore.getState().runtimeStatuses.has('sess-1')).toBe(false);
      expect(useStore.getState().cards.has('sess-1')).toBe(false);
    });

  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      // Populate everything
      useStore.getState().setStatus('connected');
      useStore.getState().setAuth('dev-1');
      useStore.getState().setSessions([mockSession]);
      useStore.getState().setDevices([mockDevice]);
      useStore.getState().appendMessage('sess-1', mockMessage);
      useStore.getState().applyCardMessage('sess-1', 'content');
      useStore.getState().setCardAction('sess-1', mockPermissionAction);
      useStore.getState().setSessionMode('sess-1', 'execute');

      // Reset
      useStore.getState().reset();

      const state = useStore.getState();
      expect(state.status).toBe('awaiting_login');
      expect(state.deviceId).toBeNull();
      expect(state.sessions.size).toBe(0);
      expect(state.devices.size).toBe(0);
      expect(state.messages.size).toBe(0);
      expect(state.cards.size).toBe(0);
      expect(state.runtimeStatuses.size).toBe(0);
      expect(state.sessionModes.size).toBe(0);
    });
  });

  describe('session modes', () => {
    it('defaults to empty map (ask is implicit)', () => {
      expect(useStore.getState().sessionModes.size).toBe(0);
    });

    it('setSessionMode stores auto mode', () => {
      useStore.getState().setSessionMode('sess-1', 'execute');
      expect(useStore.getState().sessionModes.get('sess-1')).toBe('execute');
    });

    it('setSessionMode removes entry when set to plan (default)', () => {
      useStore.getState().setSessionMode('sess-1', 'execute');
      expect(useStore.getState().sessionModes.has('sess-1')).toBe(true);
      useStore.getState().setSessionMode('sess-1', 'discuss');
      expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
    });

    it('setSessionMode preserves other sessions', () => {
      useStore.getState().setSessionMode('sess-1', 'execute');
      useStore.getState().setSessionMode('sess-2', 'execute');
      useStore.getState().setSessionMode('sess-1', 'discuss');
      expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
      expect(useStore.getState().sessionModes.get('sess-2')).toBe('execute');
    });
  });
});

describe('live card: resolved permission', () => {
  const permission = { type: 'permission' as const, payload: { id: 'p1', toolName: 'bash', args: {}, description: 'Run bash', decision: 'approve' as const } };
  it('a cleared slot keeps the resolved permission until narration resumes', () => {
    useStore.getState().setCardAction('s', permission as never);
    useStore.getState().setCardAction('s', null);
    expect(useStore.getState().cards.get('s')?.action?.type).toBe('permission');
    useStore.getState().applyCardMessage('s', 'continuing', true);
    expect(useStore.getState().cards.get('s')?.action).toBeNull();
  });
  it('an undecided permission clears normally', () => {
    useStore.getState().setCardAction('s2', { ...permission, payload: { ...permission.payload, decision: undefined } } as never);
    useStore.getState().setCardAction('s2', null);
    expect(useStore.getState().cards.get('s2')?.action).toBeNull();
  });
});
