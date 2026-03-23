import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../hooks/useStore';
import type { SessionSummary, DeviceSummary } from '@kraki/protocol';
import type { PendingPermission, PendingQuestion, ChatMessage } from '../types/store';

// Helper to reset store before each test
beforeEach(() => {
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

const mockPermission: PendingPermission = {
  id: 'perm-1',
  sessionId: 'sess-1',
  toolName: 'shell',
  args: { command: 'ls' },
  description: 'List files',
  timestamp: new Date().toISOString(),
};

const mockQuestion: PendingQuestion = {
  id: 'q-1',
  sessionId: 'sess-1',
  question: 'Which DB?',
  choices: ['sqlite', 'postgres'],
  timestamp: new Date().toISOString(),
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
  });

  describe('sessions', () => {
    it('setSessions stores sessions by id', () => {
      useStore.getState().setSessions([mockSession, mockSession2]);
      const sessions = useStore.getState().sessions;
      expect(sessions.size).toBe(2);
      expect(sessions.get('sess-1')).toEqual(mockSession);
      expect(sessions.get('sess-2')).toEqual(mockSession2);
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
  });

  describe('streaming deltas', () => {
    it('appendDelta accumulates content', () => {
      useStore.getState().appendDelta('sess-1', 'Hello ');
      useStore.getState().appendDelta('sess-1', 'world');
      expect(useStore.getState().streamingContent.get('sess-1')).toBe('Hello world');
    });

    it('appendDelta starts empty for new session', () => {
      useStore.getState().appendDelta('sess-new', 'first');
      expect(useStore.getState().streamingContent.get('sess-new')).toBe('first');
    });

    it('flushDelta removes streaming content', () => {
      useStore.getState().appendDelta('sess-1', 'some content');
      useStore.getState().flushDelta('sess-1');
      expect(useStore.getState().streamingContent.has('sess-1')).toBe(false);
    });

    it('flushDelta is safe for non-existing session', () => {
      useStore.getState().flushDelta('sess-nonexistent');
      expect(useStore.getState().streamingContent.has('sess-nonexistent')).toBe(false);
    });
  });

  describe('pending permissions', () => {
    it('addPermission stores permission', () => {
      useStore.getState().addPermission(mockPermission);
      expect(useStore.getState().pendingPermissions.size).toBe(1);
      expect(useStore.getState().pendingPermissions.get('perm-1')).toEqual(mockPermission);
    });

    it('removePermission removes permission', () => {
      useStore.getState().addPermission(mockPermission);
      useStore.getState().removePermission('perm-1');
      expect(useStore.getState().pendingPermissions.size).toBe(0);
    });

    it('removePermission is safe for non-existing id', () => {
      useStore.getState().removePermission('perm-nonexistent');
      expect(useStore.getState().pendingPermissions.size).toBe(0);
    });

    it('multiple permissions can coexist', () => {
      useStore.getState().addPermission(mockPermission);
      useStore.getState().addPermission({ ...mockPermission, id: 'perm-2' });
      expect(useStore.getState().pendingPermissions.size).toBe(2);
    });
  });

  describe('pending questions', () => {
    it('addQuestion stores question', () => {
      useStore.getState().addQuestion(mockQuestion);
      expect(useStore.getState().pendingQuestions.size).toBe(1);
      expect(useStore.getState().pendingQuestions.get('q-1')).toEqual(mockQuestion);
    });

    it('removeQuestion removes question', () => {
      useStore.getState().addQuestion(mockQuestion);
      useStore.getState().removeQuestion('q-1');
      expect(useStore.getState().pendingQuestions.size).toBe(0);
    });

    it('question with choices stored correctly', () => {
      useStore.getState().addQuestion(mockQuestion);
      const stored = useStore.getState().pendingQuestions.get('q-1');
      expect(stored?.choices).toEqual(['sqlite', 'postgres']);
    });

    it('question without choices stored correctly', () => {
      const noChoices = { ...mockQuestion, id: 'q-2', choices: undefined };
      useStore.getState().addQuestion(noChoices);
      const stored = useStore.getState().pendingQuestions.get('q-2');
      expect(stored?.choices).toBeUndefined();
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
      useStore.getState().appendDelta('sess-1', 'content');
      useStore.getState().addPermission(mockPermission);
      useStore.getState().addQuestion(mockQuestion);
      useStore.getState().setSessionMode('sess-1', 'auto');

      // Reset
      useStore.getState().reset();

      const state = useStore.getState();
      expect(state.status).toBe('awaiting_login');
      expect(state.deviceId).toBeNull();
      expect(state.sessions.size).toBe(0);
      expect(state.devices.size).toBe(0);
      expect(state.messages.size).toBe(0);
      expect(state.streamingContent.size).toBe(0);
      expect(state.pendingPermissions.size).toBe(0);
      expect(state.pendingQuestions.size).toBe(0);
      expect(state.sessionModes.size).toBe(0);
    });
  });

  describe('session modes', () => {
    it('defaults to empty map (ask is implicit)', () => {
      expect(useStore.getState().sessionModes.size).toBe(0);
    });

    it('setSessionMode stores auto mode', () => {
      useStore.getState().setSessionMode('sess-1', 'auto');
      expect(useStore.getState().sessionModes.get('sess-1')).toBe('auto');
    });

    it('setSessionMode removes entry when set to ask', () => {
      useStore.getState().setSessionMode('sess-1', 'auto');
      expect(useStore.getState().sessionModes.has('sess-1')).toBe(true);
      useStore.getState().setSessionMode('sess-1', 'ask');
      expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
    });

    it('setSessionMode preserves other sessions', () => {
      useStore.getState().setSessionMode('sess-1', 'auto');
      useStore.getState().setSessionMode('sess-2', 'auto');
      useStore.getState().setSessionMode('sess-1', 'ask');
      expect(useStore.getState().sessionModes.has('sess-1')).toBe(false);
      expect(useStore.getState().sessionModes.get('sess-2')).toBe('auto');
    });
  });
});
