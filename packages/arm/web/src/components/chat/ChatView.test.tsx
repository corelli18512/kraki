import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ChatView } from './ChatView';
import { useStore } from '../../hooks/useStore';
import { agentNavigationColors } from '../../lib/color';
import { useOutbox } from '../../lib/chat/outbox';
import { messageProvider } from '../../lib/message-provider';
import { wsClient } from '../../lib/ws-client';
import type { ChatMessage } from '../../types/store';

const viewport = vi.hoisted(() => ({ narrow: false }));
vi.mock('../../hooks/useNarrow', () => ({ useNarrow: () => viewport.narrow }));

vi.mock('./ChatScroller', () => ({
  ChatScroller: ({ rows }: { rows: { kind: string; card?: { text: string } }[] }) => <>
    <div data-testid="live-rows">{rows.filter((r) => r.kind === 'live').length}</div>
    <div data-testid="live-text">{rows.find((r) => r.kind === 'live')?.card?.text}</div>
  </>,
}));

const { getMessagesInRange } = vi.hoisted(() => ({
  getMessagesInRange: vi.fn(async () => [] as ChatMessage[]),
}));
vi.mock('../../lib/message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  deleteSessionMessages: async () => {},
  getMessagesInRange,
}));
vi.mock('./Composer', () => ({
  composerIntent: () => 'steer',
  Composer: ({ canAbort }: { canAbort: boolean }) => canAbort ? <button>Stop</button> : null,
}));

beforeEach(() => {
  viewport.narrow = false;
  useStore.setState({ sessions: new Map(), runtimeStatuses: new Map(), messages: new Map(), cards: new Map(), cardHoldUntil: new Map(), historyCaughtUpThrough: new Map() });
});

describe('ChatView history navigation', () => {
  it('sets the shared native session tint and fixed Mac clearance without changing mobile clearance', () => {
    const { container, rerender } = render(<ChatView sessionId="mv23g6gx-gq3i4yy8" topInset={40} />);
    const jump = container.querySelector<HTMLElement>('.kjump')!;
    expect(jump.style.bottom).toBe('57px');
    expect(jump.style.getPropertyValue('--k-jump-light')).toBe('hsl(95 70% 45%)');
    expect(jump.style.getPropertyValue('--k-jump-dark')).toBe(agentNavigationColors('mv23g6gx-gq3i4yy8').dark);
    viewport.narrow = true;
    rerender(<ChatView sessionId="mv23g6gx-gq3i4yy8" topInset={64} />);
    expect(jump.style.bottom).toBe('80px');
    expect(screen.getByRole('button', { name: 'Previous reply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
  });
});

describe('ChatView pending question live-row visibility', () => {
  const question = { type: 'agent_message', seq: 1, sessionId: 's', deviceId: 'd', timestamp: '',
    payload: { content: '', question: { id: 'q', text: 'Which parity color?', choices: ['Amber', 'Teal'] } } };

  function waitingCard(text = '', action: unknown = null) {
    useStore.setState({
      sessions: new Map([['s', { id: 's', state: 'active', lastSeq: 1 } as never]]),
      messages: new Map([['s', [question as never]]]),
      cards: new Map([['s', { text, action, closed: false } as never]]),
    });
  }

  it.each(['', ' \n '])('does not draw a typing row for blank draft %j under a pending question, even if the card reopened', (text) => {
    waitingCard(text);
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
  });

  it('preserves genuine streamed prose after a pending question', () => {
    waitingCard('Reading another file.');
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it.each([
    { type: 'tool_start', payload: { toolName: 'read' } },
    { type: 'tool_complete', payload: { toolName: 'read' } },
    { type: 'tool_batch', payload: { running: 6 } },
  ])('keeps parallel $type activity out of a second bubble under the newest open question', (action) => {
    waitingCard('', action);
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
  });

  it('preserves a pending permission after a pending question', () => {
    waitingCard('', { type: 'permission', payload: { id: 'p' } });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it('shows parallel tool activity again once the question has been answered', () => {
    waitingCard('', { type: 'tool_batch', payload: { running: 6 } });
    useStore.setState({
      sessions: new Map([['s', { id: 's', state: 'active', lastSeq: 2 } as never]]),
      messages: new Map([['s', [question, { type: 'user_message', seq: 2, sessionId: 's',
        payload: { content: 'Amber', answerTo: 'q' } }] as never]]),
    });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it('keeps the empty typing row for an active turn with no pending question', () => {
    waitingCard();
    useStore.setState({ messages: new Map() });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it.each([
    ['sending', '1'],
    ['failed', '0'],
  ])('a %s pending answer: only one that can still reach the agent closes the question', (state, liveRows) => {
    waitingCard();
    useOutbox.setState({ entries: [{ clientId: 'c1', sessionId: 's', text: 'Amber', answerTo: 'q', state, order: 1, createdAt: 0 } as never] });
    render(<ChatView sessionId="s" topInset={56} />);
    // Answered → the turn resumes (typing row). Failed → the question stays
    // open and answerable, so no typing row (Mac excludes failed answers).
    expect(screen.getByTestId('live-rows')).toHaveTextContent(liveRows);
    useOutbox.setState({ entries: [] });
  });

  it('a question landing keeps a parallel open permission actionable (Mac CardTurnGate)', () => {
    const permission = { type: 'permission', payload: { id: 'p1', toolName: 'shell', description: 'rm -rf build' } };
    useStore.setState({
      sessions: new Map([['s', { id: 's', state: 'active', lastSeq: 0 } as never]]),
      messages: new Map([['s', []]]),
      cards: new Map([['s', { text: 'Let me check something', action: permission, closed: false } as never]]),
    });
    useStore.getState().appendMessage('s', question as never);
    const card = useStore.getState().cards.get('s')!;
    expect(card.closed).toBe(false);
    expect(card.text).toBe('');
    expect(card.action).toEqual(permission);
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it('a question with no parallel action still ends the live bubble', () => {
    useStore.setState({
      sessions: new Map([['s', { id: 's', state: 'active', lastSeq: 0 } as never]]),
      messages: new Map([['s', []]]),
      cards: new Map([['s', { text: 'Which one?', action: null, closed: false } as never]]),
    });
    useStore.getState().appendMessage('s', question as never);
    expect(useStore.getState().cards.get('s')!.closed).toBe(true);
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
  });

  it('resumes the typing row once the question has been answered', () => {
    waitingCard();
    useStore.setState({
      sessions: new Map([['s', { id: 's', state: 'active', lastSeq: 2 } as never]]),
      messages: new Map([['s', [question, { type: 'user_message', seq: 2, sessionId: 's',
        payload: { content: 'Amber', answerTo: 'q' } }] as never]]),
    });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });
});

describe('ChatView subscription snapshot catch-up', () => {
  function userMessage(seq: number): ChatMessage {
    return { type: 'user_message', seq, sessionId: 's', deviceId: 'd', timestamp: '', payload: { content: `Prompt ${seq}` } };
  }

  function heldSnapshot(head = 100) {
    useStore.setState({
      sessions: new Map([['s', { id: 's', deviceId: 'd', deviceName: 'Mac', agent: 'pi', state: 'active', messageCount: head, lastSeq: head, readSeq: Math.min(10, head) }]]),
      messages: new Map([['s', [userMessage(10)]]]),
      cards: new Map([['s', { text: 'Snapshot draft', action: null }]]),
      cardHoldUntil: new Map([['s', head]]),
    });
    messageProvider.setTentacleInfo('s', head, 'd');
  }

  beforeEach(() => {
    messageProvider.clear();
    getMessagesInRange.mockReset();
    getMessagesInRange.mockResolvedValue([]);
  });
  afterEach(async () => {
    messageProvider.clear();
    await vi.dynamicImportSettled();
    messageProvider.setSend((msg) => wsClient.sendEncrypted(msg));
  });

  it('holds the current draft and live updates while range delivery is delayed at cached seq 10', async () => {
    heldSnapshot();
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((msg) => sent.push(msg));
    render(<ChatView sessionId="s" topInset={56} />);
    act(() => { messageProvider.reconcileTail('s', 100); });
    await vi.waitFor(() => expect(sent[0]?.payload).toMatchObject({ fromSeq: 51, toSeq: 100 }));
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');

    act(() => {
      useStore.getState().applyCardMessage('s', ' and newer words');
      useStore.getState().setCardAction('s', { type: 'permission', payload: { id: 'p', toolName: 'bash', args: {}, description: 'Run command' } });
    });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
    expect(useStore.getState().cards.get('s')?.text).toBe('Snapshot draft and newer words');

    await act(async () => {
      messageProvider.handleRangeBatch('s', Array.from({ length: 50 }, (_, i) => userMessage(51 + i)), 51, 100, false);
      // The tail completes the catch-up; the bounded bridge repair (11–50)
      // may still be loading afterwards and must not hold the card.
      await vi.waitFor(() => expect(useStore.getState().historyCaughtUpThrough.get('s')).toBe(100));
    });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
    expect(screen.getByTestId('live-text')).toHaveTextContent('Snapshot draft and newer words');
    expect(useStore.getState().sessions.get('s')).toMatchObject({ lastSeq: 100, readSeq: 10 });
  });

  it('releases the hold when the authoritative tail is delivered from IDB', async () => {
    heldSnapshot();
    getMessagesInRange.mockResolvedValue(Array.from({ length: 50 }, (_, i) => userMessage(51 + i)));
    const send = vi.fn();
    messageProvider.setSend(send);
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
    await act(async () => { await messageProvider.fetchRange('s', 51, 100); });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it.each(['sparse', 'empty'] as const)('releases a legacy head 9 hold after a successful %s tail response ending at persistent row 2', async (response) => {
    heldSnapshot(9);
    const persistent = [userMessage(1), { ...userMessage(2), type: 'agent_message' as const }];
    // Sparse rows arrive from the server; only the empty-response variant
    // already has them cached (so its actual request starts at seq 3).
    if (response === 'empty') {
      useStore.setState({ messages: new Map([['s', persistent]]) });
      getMessagesInRange.mockResolvedValue(persistent);
    } else useStore.setState({ messages: new Map([['s', []]]) });
    const send = vi.fn();
    messageProvider.setSend(send);
    render(<ChatView sessionId="s" topInset={56} />);
    act(() => { messageProvider.reconcileTail('s', 9); });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'request_session_messages_range' })));
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
    await act(async () => {
      messageProvider.handleRangeBatch('s', response === 'sparse' ? persistent : [], response === 'sparse' ? 1 : 0, response === 'sparse' ? 2 : 0, false);
      await vi.waitFor(() => expect(messageProvider.isLoading('s')).toBe(false));
    });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
    expect(useStore.getState().historyCaughtUpThrough.get('s')).toBe(9);
    expect(useStore.getState().cardHoldUntil.get('s')).toBe(9);
    expect(Math.max(...useStore.getState().messages.get('s')!.map((m) => m.seq))).toBe(2);
  });

  it('releases a waiting permission after the bounded range timeout without claiming coverage', async () => {
    vi.useFakeTimers();
    try {
      heldSnapshot();
      useStore.getState().setCardAction('s', { type: 'permission', payload: { id: 'p', toolName: 'bash', args: {}, description: 'Run command' } });
      let requestedAt = 0;
      const send = vi.fn(() => { requestedAt = Date.now(); });
      messageProvider.setSend(send);
      render(<ChatView sessionId="s" topInset={56} />);
      act(() => { messageProvider.reconcileTail('s', 100); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await act(async () => { await vi.advanceTimersByTimeAsync(requestedAt + 9_999 - Date.now()); });
      expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(messageProvider.isLoading('s')).toBe(false);
      expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
      expect(useStore.getState().cards.get('s')?.action?.type).toBe('permission');
      expect(useStore.getState().historyCaughtUpThrough.has('s')).toBe(false);
      expect(useStore.getState().cardHoldUntil.has('s')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release a newer snapshot hold when an older catch-up times out', async () => {
    vi.useFakeTimers();
    try {
      heldSnapshot();
      const send = vi.fn();
      messageProvider.setSend(send);
      render(<ChatView sessionId="s" topInset={56} />);
      act(() => { messageProvider.reconcileTail('s', 100); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      act(() => { useStore.getState().holdCard('s', 200); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
      expect(useStore.getState().cardHoldUntil.get('s')).toBe(200);
      expect(useStore.getState().historyCaughtUpThrough.has('s')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count a cancelled fetch response as coverage for a replacement snapshot', async () => {
    heldSnapshot();
    const send = vi.fn();
    messageProvider.setSend(send);
    render(<ChatView sessionId="s" topInset={56} />);
    let fetch!: Promise<void>;
    act(() => { fetch = messageProvider.fetchRange('s', 51, 100, { foreground: true }); });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await act(async () => {
      messageProvider.handleRangeBatch('s', [], 0, 0, false);
      messageProvider.clear();
      expect(useStore.getState().cardHoldUntil.has('s')).toBe(false);
      useStore.getState().holdCard('s', 100);
      await fetch;
    });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
    expect(useStore.getState().historyCaughtUpThrough.has('s')).toBe(false);
  });

  it('does not release a snapshot hold for a partial range, another session, or transient seqs', () => {
    heldSnapshot();
    render(<ChatView sessionId="s" topInset={56} />);
    act(() => {
      messageProvider.handleRangeBatch('s', [userMessage(90)], 90, 90, true);
      messageProvider.handleRangeBatch('other', [{ ...userMessage(100), sessionId: 'other' }], 100, 100, false);
      useStore.getState().appendMessage('s', { type: 'active', seq: 100, sessionId: 's', deviceId: 'd', timestamp: '', payload: {} });
      useStore.getState().appendMessage('s', { ...userMessage(100.5) });
      const session = useStore.getState().sessions.get('s')!;
      useStore.getState().upsertSession({ ...session, lastSeq: 90 });
    });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
    act(() => { messageProvider.handleRangeBatch('s', [userMessage(100)], 100, 100, false); });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it('keeps later live actions behind an initially empty subscription snapshot hold', () => {
    heldSnapshot();
    useStore.setState({ cards: new Map() });
    render(<ChatView sessionId="s" topInset={56} />);
    act(() => { useStore.getState().setCardAction('s', { type: 'tool_start', payload: { toolName: 'bash', toolCallId: 't' } }); });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
    act(() => { useStore.getState().appendMessage('s', userMessage(100)); });
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it('shows a zero-head snapshot immediately without history', () => {
    heldSnapshot(0);
    useStore.setState({ messages: new Map() });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });
});

describe('ChatView compaction indicator', () => {
  it('does not show the capsule for an idle session', () => {
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows runtime compaction without an empty live bubble and keeps Stop available', () => {
    useStore.setState({
      runtimeStatuses: new Map([['s', { status: 'compacting' }]]),
      cards: new Map([['s', { text: '', closed: false } as never]]),
    });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByRole('status', { name: 'Compacting context' })).toHaveTextContent('Compacting context…');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByTestId('live-rows')).toHaveTextContent('0');
  });

  it('keeps an in-flight tool card visible while compacting', () => {
    useStore.setState({
      runtimeStatuses: new Map([['s', { status: 'compacting' }]]),
      cards: new Map([['s', { text: '', closed: false, action: { type: 'tool_start', payload: { toolName: 'bash' } } } as never]]),
    });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it('shows session-state compaction and removes it when idle', () => {
    useStore.setState({ sessions: new Map([['s', { id: 's', state: 'compacting' } as never]]) });
    const { rerender } = render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    useStore.setState({ sessions: new Map([['s', { id: 's', state: 'idle' } as never]]) });
    rerender(<ChatView sessionId="s" topInset={56} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
