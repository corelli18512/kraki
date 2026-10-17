import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StepsModal } from './StepsModal';
import { useStore } from '../../hooks/useStore';
import { messageProvider } from '../../lib/message-provider';
import type { ChatMessage } from '../../types/store';

const attachment = vi.hoisted(() => ({ result: null as null | { status: string; text: string | null; error: string | null } }));
vi.mock('../../hooks/useAttachment', () => ({
  useAttachmentText: () => attachment.result ?? ({ status: 'ready', text: 'First report line\nMEDIA-SUB\nLast report line', error: null }),
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

it('a failed subagent report transfer shows the error instead of loading forever (Mac parity)', () => {
  attachment.result = { status: 'error', text: null, error: 'transfer expired' };
  try {
    const dispatch = { ...message, type: 'tool_complete', seq: 1, payload: {
      toolName: 'subagent', toolCallId: 'sub', success: true,
      subagent: { name: 'delegate', task: 'Reply', durationMs: 8000 },
      resultRef: { type: 'content_ref', id: 'report', mimeType: 'text/plain', size: 42 },
    } } as ChatMessage;
    useStore.setState({ messages: new Map([['s', [dispatch, message]]]) });
    render(<StepsModal sessionId="s" bubbleSeq={2} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent delegate' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load: transfer expired');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  } finally {
    attachment.result = null;
  }
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

describe('StepsModal — modal focus (native sheet)', () => {
  it('takes focus from the trigger, keeps Tab inside, and restores the trigger on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'bubble';
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<StepsModal sessionId="s" bubbleSeq={2} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const close = screen.getByRole('button', { name: 'Close steps' });
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    expect(close).toHaveFocus();
    trigger.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
