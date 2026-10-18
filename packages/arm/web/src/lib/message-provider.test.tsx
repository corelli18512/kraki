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
import type { ChatMessage } from '../types/store';

vi.mock('./ws-client', () => ({
  wsClient: {
    sendInput: vi.fn(), approve: vi.fn(), deny: vi.fn(),
    answer: vi.fn(), markRead: vi.fn(),
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

    expect(spy).toHaveBeenCalledWith('s1', 51, 100, { initial: true, foreground: true });
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

    expect(spy).toHaveBeenCalledWith('s1', 51, 100, { initial: true, foreground: true });
    spy.mockRestore();
  });

  it('does not let an older idle move the authoritative tail backward', () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 500, 'd1');
    messageProvider.setTentacleInfo('s1', 496, 'd1');

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).toHaveBeenCalledWith('s1', 451, 500, { initial: true, foreground: true });
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

  it('rechecks a foreground tail after an equal-through warm-up finishes', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 318, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((message) => sent.push(message));

    // A background warm-up reached the same authoritative seq first. The
    // mounted detail reconciliation must not be forgotten merely because the
    // in-flight range claims to cover the same tail.
    const warmup = messageProvider.fetchRange('s1', 269, 318);
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === 'request_session_messages_range')).toHaveLength(1);
    });

    messageProvider.reconcileTail('s1', 318);
    messageProvider.handleRangeBatch('s1', [], 0, 0, false);
    await warmup;

    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === 'request_session_messages_range')).toHaveLength(2);
    });
    expect(sent.filter((message) => message.type === 'request_session_messages_range')[1]?.payload).toMatchObject({
      sessionId: 's1',
      fromSeq: 269,
      toSeq: 318,
      targetDeviceId: 'd1',
    });

    messageProvider.handleRangeBatch('s1', [], 0, 0, false);
    await vi.waitFor(() => {
      expect(messageProvider.isLoading('s1')).toBe(false);
    });
  });
});

describe('message-provider: authoritative bridge tombstones', () => {
  function rows(from: number, to: number): ChatMessage[] {
    return Array.from({ length: to - from + 1 }, (_, index) => ({
      type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: from + index,
      timestamp: '', payload: { content: `message ${from + index}` },
    }));
  }

  function bridgeFixture(sparse: boolean) {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    useStore.getState().prependMessages('s1', rows(20, 30));
    const requests: Array<[number, number]> = [];
    messageProvider.setSend(message => {
      const { fromSeq, toSeq } = message.payload as { fromSeq: number; toSeq: number };
      requests.push([fromSeq, toSeq]);
      const response = fromSeq === 31 ? (sparse ? [...rows(35, 35), ...rows(42, 42)] : []) : rows(fromSeq, toSeq);
      queueMicrotask(() => messageProvider.handleRangeBatch('s1', response, response[0]?.seq ?? 0, response.at(-1)?.seq ?? 0, false));
    });
    return requests;
  }

  it.each([false, true])('settles an authoritative bridge and preserves older pagination (sparse=%s)', async sparse => {
    const requests = bridgeFixture(sparse);
    await messageProvider.fetchRange('s1', 51, 100, { foreground: true });
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
    expect(requests).toEqual([[51, 100], [31, 50]]);
    // Another foreground reconciliation must not rediscover the confirmed holes.
    await messageProvider.fetchRange('s1', 51, 100, { foreground: true });
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
    expect(requests).toHaveLength(2);
    await messageProvider.fetchRange('s1', 1, 19);
    await messageProvider.fetchRange('s1', 51, 100, { foreground: true });
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
    expect(requests).toEqual([[51, 100], [31, 50], [1, 19]]);
    expect(useStore.getState().messages.get('s1')?.find(message => message.seq === 1)).toBeDefined();
  });

  it.each([false, true])('continues past a settled authoritative bridge across bounded retries (sparse=%s)', async sparse => {
    const requests = bridgeFixture(sparse);
    messageProvider.setTentacleInfo('s1', 200, 'd1');
    await messageProvider.fetchRange('s1', 151, 200, { foreground: true });
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'incomplete', remaining: [[81, 150]] });
    messageProvider.retryRange('s1');
    await vi.waitFor(() => expect(messageProvider.isLoading('s1')).toBe(false));
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'incomplete', remaining: [[131, 150]] });
    messageProvider.retryRange('s1');
    await vi.waitFor(() => expect(messageProvider.isLoading('s1')).toBe(false));
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
    expect(requests).toEqual([[151, 200], [31, 80], [81, 130], [131, 150]]);
  });

  it.each(['clear', 'invalidateSession'] as const)('revokes bridge tombstones on %s', async reset => {
    const requests = bridgeFixture(false);
    await messageProvider.fetchRange('s1', 51, 100, { foreground: true });
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
    if (reset === 'clear') messageProvider.clear();
    else messageProvider.invalidateSession('s1');
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    await messageProvider.fetchRange('s1', 51, 100, { foreground: true });
    expect(requests).toEqual([[51, 100], [31, 50], [31, 50]]);
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
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

  it('repairs a real tail gap even when fractional cache rows inflate the row count', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 334, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    // Reproduce the monitor profile exactly: the requested 285–334 window has
    // 46 durable integer rows, is missing 317/318/332/333, and contains eight
    // old fractional rows. A count-only coverage check sees 54 >= 50 and
    // falsely declares the cache complete.
    const missing = new Set([317, 318, 332, 333]);
    const cached = Array.from({ length: 50 }, (_, index) => 285 + index)
      .filter((seq) => !missing.has(seq))
      .map((seq) => ({
        type: seq === 334 ? 'user_message' : 'agent_message',
        sessionId: 's1', deviceId: 'd1', seq, timestamp: '',
        payload: { content: `message ${seq}` },
      }));
    cached.push(...Array.from({ length: 8 }, (_, index) => ({
      // Durable-looking type proves the provider also rejects by seq shape,
      // rather than relying only on the transient type allowlist.
      type: 'agent_message', sessionId: 's1', deviceId: 'd1',
      seq: 285.96 + index * 0.005, timestamp: '', payload: { content: 'old trace row' },
    })));
    expect(cached).toHaveLength(54);
    getMessagesInRange.mockResolvedValue(cached);

    const pending = messageProvider.fetchRange('s1', 285, 334, { initial: true, foreground: true });
    await vi.waitFor(() => {
      expect(sent.find((message) => message.type === 'request_session_messages_range')).toBeDefined();
    });

    const request = sent.find((message) => message.type === 'request_session_messages_range')!;
    expect(request.payload).toMatchObject({
      sessionId: 's1', fromSeq: 317, toSeq: 334, targetDeviceId: 'd1',
    });

    messageProvider.handleRangeBatch('s1', [
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 317, timestamp: '', payload: { content: 'older recovered reply' } },
      { type: 'idle', sessionId: 's1', deviceId: 'd1', seq: 318, timestamp: '', payload: {} },
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 332, timestamp: '', payload: { content: 'latest recovered reply' } },
      { type: 'idle', sessionId: 's1', deviceId: 'd1', seq: 333, timestamp: '', payload: {} },
      { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 334, timestamp: '', payload: { content: 'next turn' } },
    ], 317, 334, false);
    await pending;

    const delivered = useStore.getState().messages.get('s1') ?? [];
    expect(delivered.some((message) => 'seq' in message && message.seq === 332)).toBe(true);
    expect(delivered.every((message) => !('seq' in message) || Number.isInteger(message.seq))).toBe(true);
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

  it('continues the producer-capped newer suffix with the missing older interval', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 1000, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    const pending = messageProvider.fetchRange('s1', 1, 1000, { initial: true });
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    // Real producer contract: a >500 request keeps its newest 500 rows.
    const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => ({
      type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: from + index, timestamp: '',
      payload: { content: `row ${from + index}` },
    }));
    messageProvider.handleRangeBatch('s1', rows(501, 1000), 501, 1000, true);
    await vi.waitFor(() => { expect(sent).toHaveLength(2); });
    expect(sent[1].payload).toMatchObject({ fromSeq: 1, toSeq: 500 });
    messageProvider.handleRangeBatch('s1', rows(1, 500), 1, 500, false);
    await pending;

    expect(useStore.getState().messages.get('s1')?.map(message => 'seq' in message ? message.seq : 0))
      .toEqual(Array.from({ length: 1000 }, (_, index) => index + 1));
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
  });
});

describe('message-provider: older paging completion', () => {
  function start() {
    setupSession();
    messageProvider.setTentacleInfo('s1', 200, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((message) => sent.push(message));
    return sent;
  }

  it('distinguishes an authoritative empty range from a busy/skipped request', async () => {
    const sent = start();
    const pending = messageProvider.fetchRange('s1', 61, 120);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await expect(messageProvider.fetchRange('s1', 1, 60)).resolves.toBe(false);
    messageProvider.handleRangeBatch('s1', [], 0, 0, false);
    await expect(pending).resolves.toBe(true);
  });

  it('does not advance history on a timeout, and lets a later gesture retry', async () => {
    vi.useFakeTimers();
    try {
      const sent = start();
      const pending = messageProvider.fetchRange('s1', 61, 120);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBe(false);
      const retry = messageProvider.fetchRange('s1', 61, 120);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      messageProvider.handleRangeBatch('s1', [], 0, 0, false);
      expect(messageProvider.isLoading('s1')).toBe(true);
      expect(sent).toHaveLength(3);
      messageProvider.handleRangeBatch('s1', [], 0, 0, false);
      await expect(retry).resolves.toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('does not advance an older cursor when a timed-out different range replies late', async () => {
    vi.useFakeTimers();
    try {
      const sent = start();
      const tail = messageProvider.fetchRange('s1', 151, 200);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(tail).resolves.toBe(false);

      let olderCursor = 121;
      const older = messageProvider.fetchRange('s1', 61, 120).then((complete) => {
        if (complete) olderCursor = 61;
        return complete;
      });
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      messageProvider.handleRangeBatch('s1', [
        { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 200, timestamp: '', payload: { content: 'Late tail' } },
      ], 200, 200, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(olderCursor).toBe(121);
      expect(messageProvider.isLoading('s1')).toBe(true);
      // Unsolicited late rows are retained without completing the older pull.
      expect(useStore.getState().messages.get('s1')?.some((message) => 'seq' in message && message.seq === 200)).toBe(true);

      // Bounds must also be checked on every row, not just batch metadata.
      messageProvider.handleRangeBatch('s1', [
        { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 199, timestamp: '', payload: { content: 'Mismatched row' } },
      ], 61, 120, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(olderCursor).toBe(121);
      expect(messageProvider.isLoading('s1')).toBe(true);

      messageProvider.handleRangeBatch('s1', [
        { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 90, timestamp: '', payload: { content: 'Mismatched metadata' } },
      ], 151, 200, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(olderCursor).toBe(121);
      expect(messageProvider.isLoading('s1')).toBe(true);

      messageProvider.handleRangeBatch('s1', [
        { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 90, timestamp: '', payload: { content: 'Requested older history' } },
      ], 90, 90, false);
      await expect(older).resolves.toBe(true);
      expect(olderCursor).toBe(61);
    } finally {
      messageProvider.clear();
      vi.useRealTimers();
    }
  });

  it('rechecks an ambiguous empty answer once after a previous range timed out', async () => {
    vi.useFakeTimers();
    try {
      const sent = start();
      const tail = messageProvider.fetchRange('s1', 151, 200);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(tail).resolves.toBe(false);
      const older = messageProvider.fetchRange('s1', 61, 120);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(9000);
      messageProvider.handleRangeBatch('s1', [], 0, 0, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(messageProvider.isLoading('s1')).toBe(true);
      expect(sent).toHaveLength(3);
      expect(sent[2]?.payload).toMatchObject({ fromSeq: 61, toSeq: 120 });
      // The retry gets its own timeout, rather than inheriting the old deadline.
      await vi.advanceTimersByTimeAsync(2000);
      expect(messageProvider.isLoading('s1')).toBe(true);
      messageProvider.handleRangeBatch('s1', [], 0, 0, false);
      await expect(older).resolves.toBe(true);
      expect(sent).toHaveLength(3);
    } finally {
      messageProvider.clear();
      vi.useRealTimers();
    }
  });

  it('does not treat disconnect cancellation as an empty completed range', async () => {
    const sent = start();
    const pending = messageProvider.fetchRange('s1', 61, 120);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    messageProvider.clear();
    await expect(pending).resolves.toBe(false);
  });

  it('keeps an incomplete cache usable when no remote target is available', async () => {
    setupSession();
    getMessagesInRange.mockResolvedValue([
      { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 90, timestamp: '', payload: { content: 'Cached history' } },
    ]);
    await expect(messageProvider.fetchRange('s1', 61, 120)).resolves.toBe(false);
    expect(useStore.getState().messages.get('s1')).toHaveLength(1);
  });

  it('keeps a truncated page pending until its missing intervals complete', async () => {
    const sent = start();
    let olderCursor = 121;
    let settled = false;
    const pending = messageProvider.fetchRange('s1', 61, 120).then((complete) => {
      settled = true;
      if (complete) olderCursor = 61;
      return complete;
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    messageProvider.handleRangeBatch('s1', [
      { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 90, timestamp: '', payload: { content: 'Partial history' } },
    ], 90, 90, true);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].payload).toMatchObject({ fromSeq: 61, toSeq: 89 });
    expect(settled).toBe(false);
    expect(olderCursor).toBe(121);
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loading' });
    expect(useStore.getState().messages.get('s1')).toHaveLength(1);
    messageProvider.handleRangeBatch('s1', [], 0, 0, false);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2].payload).toMatchObject({ fromSeq: 91, toSeq: 120 });
    expect(olderCursor).toBe(121);
    messageProvider.handleRangeBatch('s1', [], 0, 0, false);
    await expect(pending).resolves.toBe(true);
    expect(olderCursor).toBe(61);
    expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
  });

  it('rejects an in-bounds truncated page that only repeats cached rows as no progress', async () => {
    const sent = start();
    getMessagesInRange.mockResolvedValue([
      { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 90, timestamp: '', payload: { content: 'Cached row' } },
    ]);
    const pending = messageProvider.fetchRange('s1', 61, 120);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].payload).toMatchObject({ fromSeq: 61, toSeq: 120 });
    messageProvider.handleRangeBatch('s1', [
      { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 90, timestamp: '', payload: { content: 'Repeated row' } },
    ], 90, 90, true);
    await vi.waitFor(() => expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'error', error: 'no-progress' }));
    await expect(pending).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(useStore.getState().messages.get('s1')).toHaveLength(1);
  });

  it('retains a failed tail and its retry target across successful older paging', async () => {
    vi.useFakeTimers();
    try {
      const sent = start();
      const tail = messageProvider.fetchRange('s1', 151, 200, { initial: true, foreground: true });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(tail).resolves.toBe(false);
      const failure = messageProvider.getRangeStatus('s1');
      expect(failure).toEqual({ state: 'error', error: 'timeout' });
      const older = messageProvider.fetchRange('s1', 61, 120);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      expect(messageProvider.getRangeStatus('s1')).toBe(failure);
      messageProvider.handleRangeBatch('s1', [
        { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 120, timestamp: '', payload: { content: 'Older history' } },
      ], 120, 120, false);
      await expect(older).resolves.toBe(true);
      expect(messageProvider.getRangeStatus('s1')).toBe(failure);
      messageProvider.retryRange('s1');
      await vi.waitFor(() => expect(sent).toHaveLength(3));
      expect(sent[2].payload).toMatchObject({ fromSeq: 151, toSeq: 200 });
      expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loading' });
      messageProvider.handleRangeBatch('s1', [
        { type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 200, timestamp: '', payload: { content: 'Newest history' } },
      ], 200, 200, false);
      await vi.waitFor(() => expect(sent).toHaveLength(4));
      expect(sent[3].payload).toMatchObject({ fromSeq: 121, toSeq: 150 });
      messageProvider.handleRangeBatch('s1', [], 0, 0, false);
      expect(sent).toHaveLength(5); // Confirm the ambiguous empty after timeout.
      messageProvider.handleRangeBatch('s1', [], 0, 0, false);
      await vi.waitFor(() => expect(messageProvider.isLoading('s1')).toBe(false));
      expect(messageProvider.getRangeStatus('s1')).toEqual({ state: 'loaded' });
    } finally {
      messageProvider.clear();
      vi.useRealTimers();
    }
  });
});
