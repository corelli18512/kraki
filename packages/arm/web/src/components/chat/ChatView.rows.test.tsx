import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardActionState, InnerMessage } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { outbox } from '../../lib/chat/outbox';
import { CommandState } from '../../lib/commands';
import { handleDataMessage } from '../../lib/message-router';
import { wsClient } from '../../lib/ws-client';
import { messageProvider } from '../../lib/message-provider';
import { contentOf } from '../../lib/chat/spine';
import { ChatView } from './ChatView';
import { LIVE_KEY, type ChatRow } from './Bubble';

vi.mock('../../lib/message-db', () => ({ putMessage: async () => {} }));
vi.mock('../../hooks/useNarrow', () => ({ useNarrow: () => false }));
vi.mock('./Composer', () => ({ composerIntent: () => 'steer', Composer: () => null }));
vi.mock('./ChatScroller', () => ({
  ChatScroller: ({ rows }: { rows: ChatRow[] }) => <ol>{rows.map((row) => <li key={row.key} data-testid="row" data-key={row.key}>
    {row.kind === 'live' ? `live: ${row.card.text}` : row.kind === 'pending' ? row.entry.text : contentOf(row.item.message)}
  </li>)}</ol>,
}));

// Keep the production ws-client outbox hooks (write-time head and local steer).
void wsClient;
const deliveryDeps = outbox.depsForTesting()!;
const permission = { type: 'permission', payload: { id: 'p', toolName: 'bash', args: {}, description: 'Run' } } as CardActionState;
const tool = { type: 'tool_start', payload: { toolName: 'read', toolCallId: 't', headline: 'Read' } } as CardActionState;
let seq: number;
function route(type: string, payload: Record<string, unknown> = {}) {
  handleDataMessage({ type, sessionId: 's', deviceId: 'd', timestamp: '', seq: seq++, payload } as InnerMessage,
    { cmdState: new CommandState() });
}
function shown() { return screen.queryAllByTestId('row').map((row) => row.textContent); }
function liveKeys() { return screen.queryAllByTestId('row').filter((row) => row.dataset.key === LIVE_KEY); }
function delta(text: string, reset = false) { route('agent_message_delta', { content: text, reset }); }
function echo(clientId: string, content: string) { route('user_message', { content, delivery: 'steer', clientId }); }
function snapshot(text: string, action: CardActionState | null, live: boolean) {
  wsClient['applySubscriptionSnapshot']({
    type: 'session_subscription_set', deviceId: 'd', seq: 0, timestamp: '',
    payload: { accepted: true, sessionId: 's', snapshot: {
      digest: { id: 's', agent: 'pi', state: live ? 'active' : 'idle', mode: 'auto', lastSeq: 1,
        readSeq: 1, messageCount: 1, createdAt: '' },
      spineHeadSeq: 1, card: { draft: text, action },
    } },
  });
}

beforeEach(() => {
  seq = 1;
  vi.spyOn(messageProvider, 'reconcileTail').mockImplementation(() => {});
  useStore.getState().reset();
  outbox.configure({ ...deliveryDeps, send: async () => true, isDeliveryPathUp: () => true });
  useStore.getState().upsertSession({ id: 's', deviceId: 'd', deviceName: 'Test', agent: 'pi', state: 'active', messageCount: 0 });
  route('user_message', { content: 'Refactor it' });
});
afterEach(() => { cleanup(); outbox.reset(); });

describe('ChatView concluded card turns', () => {
  it.each(['agent_message', 'turn_status', 'interrupted_turn', 'system_message', 'idle', 'session_ended'])(
    '%s rejects late prose, tools and permissions until an accepted prompt', (type) => {
      delta('Draft');
      route(type, { content: 'Done', draft: 'Done', action: { type: 'user_abort', payload: {} } });
      render(<ChatView sessionId="s" topInset={40} />);
      const retired = shown();
      act(() => {
        delta('Late words', true);
        route('card_action', { action: tool });
        route('card_action', { action: permission });
      });
      expect(shown()).toEqual(retired);
      expect(liveKeys()).toHaveLength(0);
      act(() => {
        route('user_message', { content: 'Next task' });
        const session = useStore.getState().sessions.get('s')!;
        useStore.getState().upsertSession({ ...session, state: 'active' });
        delta('Fresh draft');
      });
      expect(shown().at(-1)).toBe('live: Fresh draft');
      expect(liveKeys()).toHaveLength(1);
    });

  it('queued prompts and duplicate echoes cannot reopen a concluded turn', () => {
    route('agent_message', { content: 'Done' });
    outbox.send('s', 'Queued prompt');
    const original = useStore.getState().messages.get('s')![0];
    useStore.getState().appendMessage('s', original);
    delta('Late draft');
    route('card_action', { action: permission });
    render(<ChatView sessionId="s" topInset={40} />);
    expect(liveKeys()).toHaveLength(0);
  });

  it('a draftless conclusion also retires the turn', () => {
    useStore.getState().clearCard('s');
    route('agent_message', { content: 'Done' });
    route('card_action', { action: permission });
    delta('Late draft');
    render(<ChatView sessionId="s" topInset={40} />);
    expect(liveKeys()).toHaveLength(0);
  });

  it.each([null, permission])('a question lands only its segment and permits continuation (action %j)', (action) => {
    delta('Lead-in');
    route('card_action', { action });
    route('agent_message', { content: 'Which?', question: { id: 'q', text: 'Which?', choices: ['A', 'B'] } });
    render(<ChatView sessionId="s" topInset={40} />);
    expect(liveKeys()).toHaveLength(action ? 1 : 0);
    act(() => delta('Continuing'));
    expect(shown().at(-1)).toBe('live: Continuing');
    expect(useStore.getState().cards.get('s')?.action).toEqual(action);
  });

  it('only authoritative live snapshots reopen a concluded turn; idle snapshots reject stale cards', () => {
    route('agent_message', { content: 'Done' });
    snapshot('Stale', permission, false);
    delta('Late');
    render(<ChatView sessionId="s" topInset={40} />);
    expect(liveKeys()).toHaveLength(0);
    act(() => snapshot('', null, true));
    act(() => delta('New turn'));
    expect(shown().at(-1)).toBe('live: New turn');
  });
});

describe('ChatView failed input placement', () => {
  it('holds failed A above delivered B and its reply, including restoration, ties, and retry', () => {
    const a = outbox.stage('s', 'Failed A');
    const a2 = outbox.stage('s', 'Failed A2');
    outbox.failStaged(a, 'Failed A');
    outbox.failStaged(a2, 'Failed A2');
    const b = outbox.send('s', 'Delivered B');
    route('user_message', { content: 'Delivered B', clientId: b });
    route('agent_message', { content: 'Reply to B' });
    render(<ChatView sessionId="s" topInset={40} />);
    const expected = ['Refactor it', 'Failed A', 'Failed A2', 'Delivered B', 'Reply to B'];
    expect(shown()).toEqual(expected);
    act(() => outbox.reloadForTesting());
    expect(shown()).toEqual(expected);
    expect(outbox.forSession('s').map((e) => e.afterSeq)).toEqual([1, 1]);
    act(() => outbox.retry(a));
    expect(shown()).toEqual(['Refactor it', 'Failed A2', 'Delivered B', 'Reply to B', 'Failed A']);
  });

  it('anchors typed sends too without adding client-only placement to the wire', async () => {
    const sent: Record<string, unknown>[] = [];
    outbox.configure({ ...deliveryDeps, send: async (msg) => { sent.push(msg); return false; }, isDeliveryPathUp: () => true });
    const id = outbox.send('s', 'Typed A');
    // Retry refusal is a real failed send, unlike the initial queued refusal.
    await Promise.resolve();
    outbox.retry(id);
    await Promise.resolve();
    expect(outbox.forSession('s')[0]).toMatchObject({ state: 'failed', afterSeq: 1 });
    expect(sent[0].payload).not.toHaveProperty('afterSeq');
    route('user_message', { content: 'Delivered B' });
    route('agent_message', { content: 'Reply to B' });
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown()).toEqual(['Refactor it', 'Typed A', 'Delivered B', 'Reply to B']);
  });

  it('keeps an anchor outside the loaded window at the tail', () => {
    const a = outbox.stage('s', 'Older failure');
    outbox.failStaged(a, 'Older failure');
    seq = 10;
    useStore.setState({ messages: new Map() });
    route('user_message', { content: 'Loaded prompt' });
    route('agent_message', { content: 'Loaded reply' });
    outbox.reloadForTesting();
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown()).toEqual(['Loaded prompt', 'Loaded reply', 'Older failure']);
  });
});

describe('ChatView steer segment placement', () => {
  it.each(['send', 'stage'] as const)('local %s keeps the segment above pending and echoed steer until reset', (method) => {
    delta('Parser.');
    render(<ChatView sessionId="s" topInset={40} />);
    let id = '';
    act(() => { id = outbox[method]('s', 'Use new API', { delivery: 'steer' }); });
    expect(shown()).toEqual(['Refactor it', 'live: Parser.', 'Use new API']);
    act(() => delta(' Lexer.'));
    expect(shown()).toEqual(['Refactor it', 'live: Parser. Lexer.', 'Use new API']);
    act(() => echo(id, 'Use new API'));
    expect(shown()).toEqual(['Refactor it', 'live: Parser. Lexer.', 'Use new API']);
    act(() => delta('Using new API.', true));
    expect(shown()).toEqual(['Refactor it', 'Use new API', 'live: Using new API.']);
    expect(liveKeys()).toHaveLength(1);
    act(() => route('agent_message', { content: 'Done' }));
    expect(shown()).toEqual(['Refactor it', 'Use new API', 'Done']);
  });

  it('a late echo does not pull the new segment back above a passed local steer', () => {
    delta('Writing.');
    const id = outbox.send('s', 'Add seals', { delivery: 'steer' });
    delta('Seals.', true);
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown()).toEqual(['Refactor it', 'Add seals', 'live: Seals.']);
    act(() => echo(id, 'Add seals'));
    expect(shown()).toEqual(['Refactor it', 'Add seals', 'live: Seals.']);
    act(() => echo('b', 'Shorter'));
    expect(shown()).toEqual(['Refactor it', 'Add seals', 'live: Seals.', 'Shorter']);
    expect(liveKeys()).toHaveLength(1);
  });

  it.each([true, false])('remote steers anchor by clientId or row identity (clientId %s)', (withId) => {
    delta('Reading.');
    route('user_message', { content: 'Faster', delivery: 'steer', ...(withId && { clientId: 'remote' }) });
    delta(' Found 12.');
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown()).toEqual(['Refactor it', 'live: Reading. Found 12.', 'Faster']);
    expect(liveKeys()).toHaveLength(1);
  });

  it('multiple steers keep the same segment above the first steer, then all precede the next segment', () => {
    delta('One.');
    echo('a', 'A');
    delta(' Two.');
    echo('b', 'B');
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown()).toEqual(['Refactor it', 'live: One. Two.', 'A', 'B']);
    act(() => delta('Both.', true));
    expect(shown()).toEqual(['Refactor it', 'A', 'B', 'live: Both.']);
  });

  it('words after an empty tool draft start the next segment below the steer', () => {
    route('card_action', { action: tool });
    echo('a', 'A');
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown()).toEqual(['Refactor it', 'live: ', 'A']);
    act(() => delta('Reading now.'));
    expect(shown()).toEqual(['Refactor it', 'A', 'live: Reading now.']);
  });

  it('an empty typing card does not anchor a steer', () => {
    echo('a', 'A');
    delta('On it.');
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown()).toEqual(['Refactor it', 'A', 'live: On it.']);
  });

  it.each(['question', 'prompt', 'snapshot'])('%s clears old placement', (boundary) => {
    delta('One.');
    echo('a', 'A');
    if (boundary === 'question') route('agent_message', { content: 'Which?', question: { id: 'q', text: 'Which?', choices: ['x'] } });
    else if (boundary === 'prompt') route('user_message', { content: 'Next task' });
    else snapshot('Snapshot.', null, true);
    delta('New words.');
    render(<ChatView sessionId="s" topInset={40} />);
    expect(shown().at(-1)).toMatch(/^live: .*New words\.$/);
    expect(liveKeys()).toHaveLength(1);
  });
});
