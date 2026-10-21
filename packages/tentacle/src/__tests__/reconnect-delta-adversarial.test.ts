import { describe, expect, it, vi } from 'vitest';
import type { RelayClient } from '../relay-client.js';
import { handleSessionMessages } from '../relay/history.js';

function history(rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], head = 10, turnStart = 4) {
  const messages = rows.map((seq) => ({ seq, type: 'agent_message', payload: JSON.stringify({ type: 'agent_message', payload: { content: `row ${seq}` } }) }));
  const send = vi.fn();
  const client = {
    consumerKeys: new Map([['arm', 'key']]), authInfo: { deviceId: 'tentacle' }, seqCounter: 0,
    sessionManager: {
      getMeta: vi.fn(() => ({ lastSeq: head })), findTurnAlignedStart: vi.fn(() => turnStart),
      getMessagesAfterSeq: vi.fn((_sid: string, after: number) => messages.filter((m) => m.seq > after)),
    },
    sendReliableUnicastTo: send,
    transportTo: () => 'head',
  };
  const request = (afterSeq?: unknown, beforeSeq?: number) => {
    handleSessionMessages(client as unknown as RelayClient, 'arm', 'session', beforeSeq, afterSeq as number);
    return send.mock.lastCall![2].payload as { messages: Array<{ seq: number }>; firstSeq: number; lastSeq: number; containsHead: boolean };
  };
  return { client, messages, request };
}

describe('PR577 reconnect delta adversarial bounds', () => {
  it.each([-1, -0.5, 4.5, null, '8', Number.NaN, Number.POSITIVE_INFINITY])('invalid afterSeq %s falls back to a complete turn', (after) => {
    const { request } = history();
    expect(request(after).messages.map((m) => m.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it.each([10, 11, Number.MAX_SAFE_INTEGER])('at/above head %s returns an empty caught-up batch', (after) => {
    const batch = history().request(after);
    expect(batch.messages).toEqual([]);
    expect(batch.lastSeq).toBe(10);
    expect(batch.containsHead).toBe(true);
  });

  it.each([0, 1, 2])('afterSeq %s below turn start preserves the latest turn', (after) => {
    expect(history().request(after).messages.map((m) => m.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it('beforeSeq takes precedence over afterSeq', () => {
    const batch = history().request(100, 8);
    expect(batch.messages.map((m) => m.seq)).toEqual([4, 5, 6, 7]);
    expect(batch.containsHead).toBe(false);
  });

  it('returns sparse spine rows without synthesizing gaps or resending cached rows', () => {
    const batch = history([1, 4, 7, 9, 10]).request(7);
    expect(batch.messages.map((m) => m.seq)).toEqual([9, 10]);
    expect(batch.firstSeq).toBe(9);
    expect(batch.lastSeq).toBe(10);
  });

  it('only off-spine rows after the cursor still reports caught up', () => {
    const fixture = history();
    fixture.messages.find((m) => m.seq === 9)!.type = 'tool_start';
    fixture.messages.find((m) => m.seq === 10)!.type = 'agent_narration';
    const batch = fixture.request(8);
    expect(batch.messages).toEqual([]);
    expect(batch.lastSeq).toBe(10);
    expect(batch.containsHead).toBe(true);
  });

  it('older apps omitting afterSeq receive the full latest turn', () => {
    expect(history().request().messages.map((m) => m.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it('hard cap survives a cursor below a very long turn', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => i + 1);
    const batch = history(rows, 1200, 1).request(200);
    expect(batch.messages).toHaveLength(500);
    expect(batch.firstSeq).toBe(701);
  });
});
