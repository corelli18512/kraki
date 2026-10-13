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
