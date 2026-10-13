import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StepsModal } from './StepsModal';
import { messageProvider } from '../../lib/message-provider';
import { useStore } from '../../hooks/useStore';

vi.mock('../../lib/message-db', () => ({ putMessages: async () => {}, clearAllMessages: async () => {} }));
beforeEach(() => {
  messageProvider.clear();
  useStore.getState().reset();
  useStore.setState({ messages: new Map([['s1', [
    { type: 'user_message', seq: 1, payload: { content: 'Reply' } },
    { type: 'agent_message', seq: 2, payload: { content: 'Done' } },
  ] as never]]) });
});
describe('StepsModal confirmed-empty state', () => {
  it('shows loading until a complete trace batch confirms there are no steps', () => {
    render(<StepsModal sessionId="s1" bubbleSeq={2} onClose={() => {}} />);
    expect(screen.getByText('Loading steps…')).toBeInTheDocument();
    act(() => messageProvider.handleTurnTraceBatch('s1', 2, [], false));
    expect(screen.getByText('Loading steps…')).toBeInTheDocument();
    act(() => messageProvider.handleTurnTraceBatch('s1', 2, [], true));
    expect(screen.getByText('No steps recorded')).toBeInTheDocument();
    expect(screen.getByText('This turn completed without a recorded tool trace.')).toBeInTheDocument();
    expect(screen.queryByText('Loading steps…')).not.toBeInTheDocument();
  });
});
