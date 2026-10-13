import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StepsModal } from './StepsModal';
import { useStore } from '../../hooks/useStore';
import { messageProvider } from '../../lib/message-provider';
import type { ChatMessage } from '../../types/store';

vi.mock('../../hooks/useAttachment', () => ({
  useAttachmentText: () => ({ status: 'ready', text: 'First report line\nMEDIA-SUB\nLast report line', error: null }),
}));

const message = { type: 'agent_message', seq: 2, sessionId: 's', deviceId: 'd', timestamp: '', payload: { content: 'Done' } } as ChatMessage;

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ messages: new Map([['s', [message]]]) });
  messageProvider.clear();
});

describe('StepsModal — loading versus empty trace', () => {
  it('shows matching confirmed-empty copy instead of an indefinite spinner', () => {
    render(<StepsModal sessionId="s" bubbleSeq={2} onClose={() => {}} />);
    expect(screen.getByText('Loading steps…')).toBeInTheDocument();
    act(() => messageProvider.handleTurnTraceBatch('s', 2, [], false));
    expect(screen.getByText('Loading steps…')).toBeInTheDocument();
    act(() => messageProvider.handleTurnTraceBatch('s', 2, [], true));
    expect(screen.queryByText('Loading steps…')).not.toBeInTheDocument();
    expect(screen.getByText('No steps recorded')).toBeInTheDocument();
    expect(screen.getByText('This turn completed without a recorded tool trace.')).toBeInTheDocument();
  });
  it('returns to waiting when a later incomplete batch clears a loaded trace', () => {
    messageProvider.handleTurnTraceBatch('s', 2, [], true);
    render(<StepsModal sessionId="s" bubbleSeq={2} onClose={() => {}} />);
    expect(screen.getByText('No steps recorded')).toBeInTheDocument();
    act(() => messageProvider.handleTurnTraceBatch('s', 2, [], false));
    expect(screen.getByText('Loading steps…')).toBeInTheDocument();
    expect(screen.queryByText('No steps recorded')).not.toBeInTheDocument();
  });
  it('dismisses with Escape or the close button', () => {
    const close = vi.fn();
    render(<StepsModal sessionId="s" bubbleSeq={2} onClose={close} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close steps' }));
    expect(close).toHaveBeenCalledTimes(2);
  });
});

it('opens the compact subagent card, preserves report source lines and returns to Steps', () => {
  const dispatch = { ...message, type: 'tool_complete', seq: 1, payload: {
    toolName: 'subagent', toolCallId: 'sub', success: true,
    subagent: { name: 'delegate', task: 'Reply with MEDIA-SUB', durationMs: 8000 },
    resultRef: { type: 'content_ref', id: 'report', mimeType: 'text/plain', size: 42 },
  } } as ChatMessage;
  useStore.setState({ messages: new Map([['s', [dispatch, message]]]) });
  const { container } = render(<StepsModal sessionId="s" bubbleSeq={2} onClose={() => {}} />);
  expect(container.querySelector('.ksub-status svg')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open subagent delegate' }));
  expect(screen.getByText('Reply with MEDIA-SUB')).toHaveClass('ksub-page-task');
  expect(screen.getByText("The agent did not report this subagent's steps.")).toHaveClass('ksub-empty');
  expect(container.querySelector('.ksub-report .kmd p')?.textContent).toBe('First report line\nMEDIA-SUB\nLast report line');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Open subagent delegate' })).toBeInTheDocument();
});
