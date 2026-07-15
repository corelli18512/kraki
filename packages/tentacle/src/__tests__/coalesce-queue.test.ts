/**
 * Layer A — tentacle-side coalescing of the offline E2E queue (pulse §12
 * mirror). Verifies the `coalesceKeyFor` mapping (the single source of truth for
 * both the app-layer `pendingE2eQueue` dedup and the pulse `coalesceKey`) and
 * the last-one-wins dedup semantics it drives.
 *
 * Regression guard for two review findings:
 *   - the real delta type is `agent_message_delta` (NOT `delta`);
 *   - `card_action` is keyed by sessionId (its payload has no cardId).
 */

import { describe, it, expect } from 'vitest';
import { coalesceKeyFor } from '../relay-client.js';
import type { ProducerMessage } from '@kraki/protocol';

/** Mirror of RelayClient.queuePending's dedup, so we can assert the queue
 *  behavior without standing up a full RelayClient. */
function simulateQueue(msgs: Array<Partial<ProducerMessage>>): Array<Partial<ProducerMessage>> {
  let q: Array<Partial<ProducerMessage>> = [];
  for (const msg of msgs) {
    const key = coalesceKeyFor(msg);
    if (key) q = q.filter((m) => coalesceKeyFor(m) !== key);
    q.push(msg);
  }
  return q;
}

describe('coalesceKeyFor: state-covering messages are keyed, events are not', () => {
  it('keys agent_message_delta by session (real type name, not "delta")', () => {
    expect(coalesceKeyFor({ type: 'agent_message_delta', sessionId: 'sess1' })).toBe(
      'agent_message_delta:sess1',
    );
    // The wrong name from the first draft must NOT match anything.
    expect(coalesceKeyFor({ type: 'delta' as ProducerMessage['type'], sessionId: 'sess1' })).toBeUndefined();
  });

  it('keys card_action by session (payload has no cardId)', () => {
    expect(coalesceKeyFor({ type: 'card_action', sessionId: 'sess1' })).toBe('card_action:sess1');
  });

  it('keys compacting runtime state by session', () => {
    expect(coalesceKeyFor({ type: 'compacting', sessionId: 'sess1' })).toBe('compacting:sess1');
    expect(coalesceKeyFor({ type: 'compacting' })).toBeUndefined();
  });

  it('leaves durable/event messages un-keyed so pulse retains each', () => {
    for (const type of ['agent_message', 'user_message', 'tool_start', 'tool_complete',
      'session_list', 'attachment_data', 'idle', 'active', 'error'] as const) {
      expect(coalesceKeyFor({ type, sessionId: 'sess1' })).toBeUndefined();
    }
  });

  it('does not key a delta with no sessionId (nothing to scope to)', () => {
    expect(coalesceKeyFor({ type: 'agent_message_delta' })).toBeUndefined();
  });
});

describe('queue dedup: same-key sends collapse to the latest', () => {
  it('50 deltas for one session collapse to 1 (latest content)', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      type: 'agent_message_delta' as const,
      sessionId: 'sess1',
      payload: { content: `chunk-${i}`, reset: false },
    }));
    const q = simulateQueue(msgs);
    expect(q).toHaveLength(1);
    expect((q[0]!.payload as { content: string }).content).toBe('chunk-49');
  });

  it('mixed 10 delta + 5 events + 10 delta ⇒ 6 (1 latest delta + 5 events)', () => {
    const msgs: Array<Partial<ProducerMessage>> = [
      ...Array.from({ length: 10 }, () => ({ type: 'agent_message_delta' as const, sessionId: 's' })),
      ...Array.from({ length: 5 }, (_, i) => ({ type: 'user_message' as const, sessionId: 's', seq: i })),
      ...Array.from({ length: 10 }, () => ({ type: 'agent_message_delta' as const, sessionId: 's' })),
    ];
    const q = simulateQueue(msgs);
    expect(q).toHaveLength(6);
    expect(q.filter((m) => m.type === 'agent_message_delta')).toHaveLength(1);
    expect(q.filter((m) => m.type === 'user_message')).toHaveLength(5);
  });

  it('compacting phases collapse to the latest state per session', () => {
    const q = simulateQueue([
      { type: 'compacting', sessionId: 'a', payload: { phase: 'start' } },
      { type: 'compacting', sessionId: 'b', payload: { phase: 'start' } },
      { type: 'compacting', sessionId: 'a', payload: { phase: 'end', nextState: 'idle' } },
    ]);
    expect(q).toHaveLength(2);
    expect(q.find((message) => message.sessionId === 'a')?.payload).toEqual({
      phase: 'end',
      nextState: 'idle',
    });
  });

  it('distinct sessions do not coalesce each other', () => {
    const q = simulateQueue([
      { type: 'agent_message_delta', sessionId: 'a' },
      { type: 'agent_message_delta', sessionId: 'b' },
      { type: 'agent_message_delta', sessionId: 'a' },
    ]);
    expect(q).toHaveLength(2); // one per session
  });
});
