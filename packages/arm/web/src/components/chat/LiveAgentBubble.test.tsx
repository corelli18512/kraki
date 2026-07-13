import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LiveAgentBubble } from './LiveAgentBubble';
import { useStore } from '../../hooks/useStore';
import type { SessionCard, ChatMessage } from '../../types/store';

function renderLive(card: SessionCard) {
  return render(
    <MemoryRouter>
      <LiveAgentBubble sessionId="sess-1" card={card} />
    </MemoryRouter>,
  );
}

/** Seed the current turn with a leading user_message + a trace step so the
 *  bubble-level "Steps" affordance has something to open. */
function seedTurnSteps() {
  useStore.getState().appendMessage('sess-1', {
    type: 'user_message', deviceId: 'd1', seq: 1, timestamp: '', sessionId: 'sess-1',
    payload: { content: 'go' },
  } as ChatMessage);
  useStore.getState().appendMessage('sess-1', {
    type: 'tool_start', deviceId: 'd1', seq: 2, timestamp: '', sessionId: 'sess-1',
    payload: { toolName: 'bash', headline: 'ls' },
  } as ChatMessage);
}

describe('LiveAgentBubble action section', () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it('never renders a generic "Working…" / "Waiting for you" status', () => {
    renderLive({ text: 'streaming the reply…', action: null });
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for you')).not.toBeInTheDocument();
  });

  it('hides the Steps entry when the turn has no trace steps yet', () => {
    renderLive({ text: 'streaming the reply…', action: null });
    expect(screen.getByText('streaming the reply…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open steps' })).not.toBeInTheDocument();
  });

  it('exposes the Steps entry once the turn has accrued trace steps', () => {
    seedTurnSteps();
    renderLive({ text: 'streaming the reply…', action: null });
    expect(screen.getByRole('button', { name: 'Open steps' })).toBeInTheDocument();
  });

  it('renders an unresolved question with its input controls', () => {
    renderLive({
      text: '',
      action: { type: 'question', payload: { id: 'q1', question: 'pick', allowFreeform: true } },
    });
    expect(screen.getByText('pick')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type your answer…')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for you')).not.toBeInTheDocument();
  });

  it('renders a resolved (answered) question read-only until narration retires it', () => {
    renderLive({
      text: '',
      action: { type: 'question', payload: { id: 'q1', question: '晚餐想吃什么?', choices: ['面条', '米饭'], answer: '面条' } },
    });
    expect(screen.getByText('晚餐想吃什么?')).toBeInTheDocument();
    expect(screen.getByText(/Answered/)).toBeInTheDocument();
    // Read-only: no input control once answered.
    expect(screen.queryByPlaceholderText('Type your answer…')).not.toBeInTheDocument();
  });

  it('renders a resolved permission decision read-only until narration retires it', () => {
    renderLive({
      text: '',
      action: { type: 'permission', payload: { id: 'p1', description: 'Run bash', toolName: 'bash', args: {}, decision: 'approve' } },
    });
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
    // Read-only: no approve/deny buttons once decided.
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('renders an unresolved permission with its approve/deny buttons', () => {
    renderLive({
      text: '',
      action: { type: 'permission', payload: { id: 'p1', description: 'Run bash', toolName: 'bash', args: {} } },
    });
    expect(screen.getByText('Run bash')).toBeInTheDocument();
  });

  it('renders a tool_batch as a parallel-running count, without a "Working…" header', () => {
    renderLive({ text: '', action: { type: 'tool_batch', payload: { running: 3 } } });
    expect(screen.getByText(/3 个工具并行运行中/)).toBeInTheDocument();
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
  });

  it('renders compaction as transient runtime activity, not a fake tool', () => {
    renderLive({ text: '', action: { type: 'compaction', payload: { phase: 'running', reason: 'threshold' } } });
    expect(screen.getByText('Compacting context…')).toBeInTheDocument();
    expect(screen.queryByText('bash')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open steps' })).not.toBeInTheDocument();
  });

  it('renders a running tool in the action section', () => {
    renderLive({
      text: 'working on it',
      action: { type: 'tool_start', payload: { toolCallId: 't1', headline: 'ls -la', toolName: 'bash' } },
    });
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
  });

  it('renders the most-recent COMPLETED tool (latest activity is a tool, not narration)', () => {
    renderLive({
      text: '',
      action: { type: 'tool_complete', payload: { toolCallId: 't1', headline: 'ls -la', success: true, toolName: 'bash' } },
    });
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
    // No "Running" prefix for a completed tool.
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
  });
});
