import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { StepsList } from './StepsList';
import type { ChatMessage } from '../../types/store';

function makeMsg(type: string, payload: Record<string, unknown>, seq: number): ChatMessage {
  return {
    type,
    deviceId: 'dev-1',
    seq,
    timestamp: '2026-07-05T12:00:00.000Z',
    sessionId: 'sess-1',
    payload,
  } as ChatMessage;
}

function renderSteps(messages: ChatMessage[]) {
  return render(
    <MemoryRouter>
      <StepsList messages={messages} agent="pi" sessionId="sess-1" />
    </MemoryRouter>,
  );
}

describe('StepsList tool_start → tool_complete merge (protocol contract)', () => {
  it('renders a completed tool as a SINGLE chip (drops the matching tool_start)', () => {
    renderSteps([
      makeMsg('tool_start', { toolName: 'bash', headline: '$ echo hi', toolCallId: 't1' }, 1),
      makeMsg('tool_complete', { toolName: 'bash', headline: '$ echo hi', toolCallId: 't1', success: true }, 2),
    ]);
    // "Running" chip for the tool_start must be gone once completed.
    expect(screen.queryByText(/Running/i)).not.toBeInTheDocument();
    // Exactly one "bash" chip remains (the completed one).
    expect(screen.getAllByText('bash')).toHaveLength(1);
  });

  it('keeps a tool_start chip while the tool is still in-flight (no tool_complete)', () => {
    renderSteps([
      makeMsg('tool_start', { toolName: 'bash', headline: '$ sleep 1', toolCallId: 't2' }, 1),
    ]);
    expect(screen.getByText(/Running/i)).toBeInTheDocument();
  });

  it('interleaves narration prose with a merged tool chip', () => {
    renderSteps([
      makeMsg('agent_narration', { content: 'Now executing the command:' }, 1),
      makeMsg('tool_start', { toolName: 'bash', headline: '$ echo x', toolCallId: 't3' }, 2),
      makeMsg('tool_complete', { toolName: 'bash', headline: '$ echo x', toolCallId: 't3', success: true }, 3),
    ]);
    expect(screen.getByText('Now executing the command:')).toBeInTheDocument();
    expect(screen.queryByText(/Running/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('bash')).toHaveLength(1);
  });

  it('merges each toolCallId independently (two tools → two chips, no Running)', () => {
    renderSteps([
      makeMsg('tool_start', { toolName: 'bash', headline: '$ echo a', toolCallId: 'a' }, 1),
      makeMsg('tool_start', { toolName: 'bash', headline: '$ echo b', toolCallId: 'b' }, 2),
      makeMsg('tool_complete', { toolName: 'bash', headline: '$ echo a', toolCallId: 'a', success: true }, 3),
      makeMsg('tool_complete', { toolName: 'bash', headline: '$ echo b', toolCallId: 'b', success: true }, 4),
    ]);
    expect(screen.queryByText(/Running/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('bash')).toHaveLength(2);
  });
});
