import { describe, expect, it } from 'vitest';
import { highestSeq, lowestSeq } from './ChatView';
import { openQuestions } from '../../lib/chat/spine';
import type { ChatMessage } from '../../types/store';

const m = (type: string, seq: number, payload: Record<string, unknown> = {}): ChatMessage =>
  ({ type, seq, sessionId: 's', deviceId: 'd', timestamp: '2026-10-22T00:00:00Z', payload }) as unknown as ChatMessage;
const ask = (seq: number) => m('agent_message', seq, { content: 'Delete it?', question: { id: 'q1', text: 'Delete it?', choices: ['yes', 'no'] } });

describe('conversation head ignores runtime signals', () => {
  it('a foreign-seq active does not make the window look caught up', () => {
    // The question (3) was answered on another device (4, 5) but those rows
    // are not loaded yet; an `active` with the relay broadcast seq arrives.
    const messages = [m('idle', 2), ask(3), m('active', 529)];
    expect(highestSeq(messages)).toBe(3);
    const lastSeq = 5;
    const atHead = highestSeq(messages) >= lastSeq;
    expect(atHead).toBe(false);
    // So the stale question is not offered as answerable.
    expect(openQuestions(messages, [], atHead)).toEqual([]);
  });

  it('a question at the head stays answerable with an active after it', () => {
    const messages = [m('idle', 2), ask(3), m('active', 529)];
    const atHead = highestSeq(messages) >= 3;
    expect(openQuestions(messages, [], atHead).map((q) => q.id)).toEqual(['q1']);
  });
});

describe('conversation tail ignores runtime signals', () => {
  it('a restarted-counter active below the window does not move the older-paging cursor', () => {
    // After a tentacle restart its broadcast counter starts at 0 again, so an
    // `active` can carry a seq far below the loaded spine window.
    const messages = [m('agent_message', 1940), m('idle', 2000), m('active', 37), m('compacting', 12)];
    expect(lowestSeq(messages)).toBe(1940);
  });
});
