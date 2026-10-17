import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatView } from './ChatView';
import { useStore } from '../../hooks/useStore';
import { agentNavigationColors } from '../../lib/color';
import { useOutbox } from '../../lib/chat/outbox';

const viewport = vi.hoisted(() => ({ narrow: false }));
vi.mock('../../hooks/useNarrow', () => ({ useNarrow: () => viewport.narrow }));

vi.mock('./ChatScroller', () => ({
  ChatScroller: ({ rows }: { rows: { kind: string }[] }) => <div data-testid="live-rows">{rows.filter((r) => r.kind === 'live').length}</div>,
}));
vi.mock('./Composer', () => ({
  composerIntent: () => 'steer',
  Composer: ({ canAbort }: { canAbort: boolean }) => canAbort ? <button>Stop</button> : null,
}));

beforeEach(() => {
  viewport.narrow = false;
  useStore.setState({ sessions: new Map(), runtimeStatuses: new Map(), messages: new Map(), cards: new Map() });
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
