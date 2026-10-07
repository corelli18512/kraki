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

describe('StepsList subagents', () => {
  const trace = [
    makeMsg('agent_narration', { content: 'Delegating.' }, 1),
    makeMsg('tool_start', { toolName: 'Agent', headline: 'Find it', toolCallId: 'A', subagent: { name: 'scout', task: 'Find codeword', status: 'running' } }, 2),
    makeMsg('agent_narration', { content: 'I will grep.', parentToolCallId: 'A' }, 3),
    makeMsg('tool_start', { toolName: 'grep', headline: '/CODEWORD/', toolCallId: 'g', parentToolCallId: 'A' }, 4),
    makeMsg('tool_complete', { toolName: 'grep', headline: '/CODEWORD/', toolCallId: 'g', parentToolCallId: 'A' }, 5),
    makeMsg('agent_narration', { content: 'Waiting.' }, 6),
    // Background subagent: completes later, with usage.
    makeMsg('tool_complete', { toolName: 'Agent', headline: 'Find it', toolCallId: 'A', subagent: { name: 'scout', status: 'completed', durationMs: 9000 } }, 7),
  ];

  it('shows a dispatch as one card where it started; its own steps stay off the top level', () => {
    let opened = '';
    render(<MemoryRouter><StepsList messages={trace} sessionId="sess-1" onOpenSubagent={(id) => { opened = id; }} /></MemoryRouter>);
    expect(screen.queryByText('I will grep.')).not.toBeInTheDocument();
    expect(screen.queryByText('grep')).not.toBeInTheDocument();
    const card = screen.getByRole('button', { name: 'Open subagent scout' });
    expect(card).toHaveTextContent('Find codeword');
    expect(card).toHaveTextContent('1 step · 9s');
    // The card sits where the agent delegated (before "Waiting."), not at its completion.
    const texts = [...document.querySelectorAll('.kstep-prose, .ksub-card')].map((n) => n.textContent);
    expect(texts[0]).toBe('Delegating.');
    expect(texts[1]).toContain('scout');
    expect(texts[2]).toBe('Waiting.');
    card.click();
    expect(opened).toBe('A');
  });

  it('a subagent page lists only that subagent\'s steps', () => {
    render(<MemoryRouter><StepsList messages={trace} sessionId="sess-1" parentId="A" onOpenSubagent={() => {}} /></MemoryRouter>);
    expect(screen.getByText('I will grep.')).toBeInTheDocument();
    expect(screen.getAllByText('grep')).toHaveLength(1);
    expect(screen.queryByText('Delegating.')).not.toBeInTheDocument();
  });

  it('without a navigator, a dispatch still renders as a plain tool chip', () => {
    renderSteps(trace);
    expect(screen.queryByRole('button', { name: /Open subagent/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Agent')).toHaveLength(1);
  });
});

describe('StepsList subagent groups', () => {
  it('a group dispatch counts its subagents, not steps', () => {
    render(<MemoryRouter><StepsList sessionId="sess-1" onOpenSubagent={() => {}} messages={[
      makeMsg('tool_start', { toolName: 'subagent', headline: '', toolCallId: 'P', subagent: { name: 'workflow', task: '2 subagents' } }, 1),
      makeMsg('tool_start', { toolName: 'subagent', headline: '', toolCallId: 'P#a', parentToolCallId: 'P', subagent: { name: 'Find' } }, 2),
      makeMsg('tool_start', { toolName: 'subagent', headline: '', toolCallId: 'P#b', parentToolCallId: 'P', subagent: { name: 'Count' } }, 3),
    ]} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Open subagent workflow' })).toHaveTextContent('2 subagents');
  });
});
