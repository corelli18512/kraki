import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatView } from './ChatView';
import { useStore } from '../../hooks/useStore';

vi.mock('./ChatScroller', () => ({
  ChatScroller: ({ rows }: { rows: { kind: string }[] }) => <div data-testid="live-rows">{rows.filter((r) => r.kind === 'live').length}</div>,
}));
vi.mock('./Composer', () => ({
  composerIntent: () => 'steer',
  Composer: ({ canAbort }: { canAbort: boolean }) => canAbort ? <button>Stop</button> : null,
}));

beforeEach(() => {
  useStore.setState({ sessions: new Map(), runtimeStatuses: new Map(), messages: new Map(), cards: new Map() });
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
    { type: 'tool_batch', payload: { running: 2 } },
    { type: 'permission', payload: { id: 'p' } },
  ])('preserves a genuine $type action after a pending question', (action) => {
    waitingCard('', action);
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
  });

  it('keeps the empty typing row for an active turn with no pending question', () => {
    waitingCard();
    useStore.setState({ messages: new Map() });
    render(<ChatView sessionId="s" topInset={56} />);
    expect(screen.getByTestId('live-rows')).toHaveTextContent('1');
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
