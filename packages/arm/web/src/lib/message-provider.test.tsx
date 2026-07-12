import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../hooks/useStore';
import { messageProvider } from './message-provider';

vi.mock('./ws-client', () => ({
  wsClient: {
    sendInput: vi.fn(), approve: vi.fn(), deny: vi.fn(),
    alwaysAllow: vi.fn(), answer: vi.fn(), markRead: vi.fn(),
    createSession: vi.fn(),
  },
}));

function setupSession() {
  useStore.getState().setSessions([
    { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
  ]);
  useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
}

beforeEach(() => {
  useStore.getState().reset();
  messageProvider.clear();
});

describe('message-provider: requestCard', () => {
  it('sends request_card with targetDeviceId when tentacle is encryptable', () => {
    setupSession();
    useStore.getState().setAuth('web-1');
    useStore.getState().setStatus('connected');
    useStore.getState().upsertDevice({ id: 'd1', name: 'Mac', role: 'tentacle', online: true, encryptionKey: 'key' } as any);
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    messageProvider.requestCard('s1');

    expect(sent).toEqual([{
      type: 'request_card',
      deviceId: 'web-1',
      payload: { sessionId: 's1', targetDeviceId: 'd1' },
    }]);
  });

  it('skips request_card when tentacle is not encryptable', () => {
    setupSession();
    useStore.getState().setStatus('connected');
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    messageProvider.requestCard('s1');

    expect(sent).toEqual([]);
  });

  it('waits for authentication and allows retry after reconnect', () => {
    setupSession();
    useStore.getState().setAuth('web-1');
    useStore.getState().upsertDevice({ id: 'd1', name: 'Mac', role: 'tentacle', online: true, encryptionKey: 'key' } as any);
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    messageProvider.requestCard('s1');
    expect(sent).toEqual([]);

    useStore.getState().setStatus('connected');
    messageProvider.requestCard('s1');
    expect(sent).toHaveLength(1);
  });

  it('does not restore permission/question state from replay batches', () => {
    setupSession();

    messageProvider.handleRangeBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'ls' }, description: 'List files' } },
      { type: 'question', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { id: 'q1', question: 'Which DB?', choices: ['sqlite', 'postgres'] } },
    ], 1, 2, false);

    expect(useStore.getState().cards.size).toBe(0);
  });
});

describe('message-provider: ensureLoaded', () => {
  it('triggers fetchRange when store has no messages', () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    // setSend to prevent "cannot request from tentacle" path
    messageProvider.setSend(() => {});

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).toHaveBeenCalledWith('s1', 51, 100, { initial: true });
    spy.mockRestore();
  });

  it('does not fetch when store already has messages', () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');

    // Put a message into the store
    useStore.getState().appendMessage('s1', {
      type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 99, timestamp: '',
      payload: { content: 'hello' },
    });

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not fetch when no tentacle info available', () => {
    setupSession();
    // Don't set tentacle info

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('message-provider: range-fetch protocol', () => {
  it('sends request_session_messages_range with inclusive fromSeq/toSeq', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    // fetchRange(s1, 51, 100) → afterSeq=50, limit=50
    // → fromSeq=51, toSeq=100 inclusive
    void messageProvider.fetchRange('s1', 51, 100, { initial: true });

    // fetchRange awaits dynamic imports (./message-db); poll until the send fires.
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    const rangeReq = sent.find(m => m.type === 'request_session_messages_range');
    const payload = rangeReq!.payload as Record<string, unknown>;
    expect(payload.sessionId).toBe('s1');
    expect(payload.fromSeq).toBe(51);
    expect(payload.toSeq).toBe(100);
    expect(payload.targetDeviceId).toBe('d1');

    // No legacy replay request should have been sent
    expect(sent.find(m => m.type === 'request_session_replay')).toBeUndefined();

    // Resolve the pending request so fetchRange completes its finally clause
    messageProvider.handleRangeBatch('s1', [], 0, 0, false);
    await vi.waitFor(() => {
      expect(messageProvider.isLoading('s1')).toBe(false);
    });
  });

  it('handleRangeBatch resolves the pending request and persists messages', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 10, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    const pending = messageProvider.fetchRange('s1', 1, 10, { initial: true });
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    messageProvider.handleRangeBatch('s1', [
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { content: 'first' } },
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { content: 'second' } },
    ], 1, 2, false);

    await pending;

    const msgs = useStore.getState().messages.get('s1');
    expect(msgs).toBeDefined();
    expect(msgs!.length).toBe(2);
    expect(messageProvider.isLoading('s1')).toBe(false);
  });

  it('handleRangeBatch warns but still delivers when truncated=true', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 1000, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    const pending = messageProvider.fetchRange('s1', 1, 1000, { initial: true });
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    messageProvider.handleRangeBatch('s1', [
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 501, timestamp: '',
        payload: { content: 'newer end' } },
    ], 501, 501, true);

    await pending;

    expect(useStore.getState().messages.get('s1')?.length).toBe(1);
  });
});
