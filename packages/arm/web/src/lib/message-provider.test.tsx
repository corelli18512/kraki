import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getMessagesInRange } = vi.hoisted(() => ({
  getMessagesInRange: vi.fn(async () => [] as unknown[]),
}));

vi.mock('./message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  getMessages: async () => [],
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  getMessagesInRange,
  deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {},
  clearAllMessages: async () => {},
}));

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
  getMessagesInRange.mockReset();
  getMessagesInRange.mockResolvedValue([]);
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

  it('reconciles the authoritative tail when store already has messages', () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');

    // Existing messages do not prove the tail is complete: a live broadcast
    // immediately before idle may have been missed.
    useStore.getState().appendMessage('s1', {
      type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 99, timestamp: '',
      payload: { content: 'hello' },
    });

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).toHaveBeenCalledWith('s1', 51, 100, { initial: true });
    spy.mockRestore();
  });

  it('does not let an older idle move the authoritative tail backward', () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 500, 'd1');
    messageProvider.setTentacleInfo('s1', 496, 'd1');

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).toHaveBeenCalledWith('s1', 451, 500, { initial: true });
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

  it('repairs a cached tail where a legacy transient row hides the reply seq', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 496, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    const cached = Array.from({ length: 50 }, (_, index) => {
      const seq = 447 + index;
      if (seq === 495) {
        return { type: 'active', sessionId: 's1', deviceId: 'd1', seq, timestamp: '', payload: {} };
      }
      return {
        type: seq === 496 ? 'idle' : 'agent_message',
        sessionId: 's1', deviceId: 'd1', seq, timestamp: '',
        payload: seq === 496 ? { reason: 'completed' } : { content: `message ${seq}` },
      };
    });
    getMessagesInRange.mockResolvedValue(cached);

    const pending = messageProvider.fetchRange('s1', 447, 496, { initial: true });
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    const request = sent.find(m => m.type === 'request_session_messages_range')!;
    expect(request.payload).toMatchObject({ sessionId: 's1', fromSeq: 495, toSeq: 496 });

    messageProvider.handleRangeBatch('s1', [
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 495, timestamp: '',
        payload: { content: 'recovered reply' } },
      { type: 'idle', sessionId: 's1', deviceId: 'd1', seq: 496, timestamp: '',
        payload: { reason: 'completed' } },
    ], 495, 496, false);
    await pending;

    const recovered = useStore.getState().messages.get('s1')?.find((message) =>
      'seq' in message && message.seq === 495,
    );
    expect(recovered?.type).toBe('agent_message');
    expect(recovered && 'payload' in recovered ? recovered.payload : undefined).toMatchObject({
      content: 'recovered reply',
    });
  });

  it('does not let an older timeout cancel a newer tail request', async () => {
    vi.useFakeTimers();
    try {
      setupSession();
      messageProvider.setTentacleInfo('s1', 2, 'd1');
      const sent: Record<string, unknown>[] = [];
      messageProvider.setSend((m) => sent.push(m));

      const first = messageProvider.fetchRange('s1', 1, 1);
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'request_session_messages_range')).toHaveLength(1);
      });
      messageProvider.handleRangeBatch('s1', [
        { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
          payload: { content: 'first' } },
      ], 1, 1, false);
      await first;

      await vi.advanceTimersByTimeAsync(100);
      const second = messageProvider.fetchRange('s1', 2, 2);
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'request_session_messages_range')).toHaveLength(2);
      });

      // Fire only the first request's 10s timer. The second request was armed
      // 100ms later and must remain pending for its real range batch.
      await vi.advanceTimersByTimeAsync(10_000 - 100);
      messageProvider.handleRangeBatch('s1', [
        { type: 'idle', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '', payload: {} },
      ], 2, 2, false);
      await second;

      expect(useStore.getState().messages.get('s1')?.some((message) =>
        'seq' in message && message.seq === 2,
      )).toBe(true);
    } finally {
      messageProvider.clear();
      vi.useRealTimers();
    }
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
