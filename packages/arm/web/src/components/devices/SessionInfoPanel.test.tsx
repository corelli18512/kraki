import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionInfoPanel, formatTokens } from './SessionInfoPanel';
import { useStore } from '../../hooks/useStore';
import type { ModelDetail } from '@kraki/protocol';
const commands = vi.hoisted(() => ({ setSessionModel: vi.fn(), forkSession: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn() }));
vi.mock('../../lib/ws-client', () => ({ wsClient: commands }));
const session = { id: 'complete-session-id', deviceId: 'computer', deviceName: 'Local Mac', agent: 'pi', state: 'idle' as const, messageCount: 1, model: 'm1', createdAt: '2026-04-30T08:00:00Z' };
const details: ModelDetail[] = [{ id: 'm1', name: 'Model One', supportsReasoningEffort: true, supportedReasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'low', contextWindow: 32300 }];
const usage = { inputTokens: 9100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: .004, totalDurationMs: 75000, contextTokens: 9100 };
const close = vi.fn();
beforeEach(() => { vi.clearAllMocks(); useStore.getState().reset(); useStore.setState({ devices: new Map([['computer', { id: 'computer', name: 'Local Mac', role: 'tentacle', online: true }]]), deviceVersions: new Map([['computer', '0.29.4']]) }); });
const open = () => render(<SessionInfoPanel session={session} usage={usage} models={['m1', 'm2']} modelDetails={details} onClose={close} />);
describe('SessionInfoPanel native sheet parity', () => {
  it('matches token notation and keeps zero usage, cost, duration and device metadata', () => {
    expect([999, 9100, 32300, 1000000].map(formatTokens)).toEqual(['999', '9.1K', '32K', '1.0M']);
    open();
    for (const label of ['Session ID', 'Created', 'Cache read', 'Cache write', 'Total cost', 'Duration', 'Device']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('$0.0040')).toBeInTheDocument();
    expect(screen.getByText('1m 15s')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Context usage' })).toHaveAttribute('aria-valuenow', '28');
    expect(screen.getByText('9.1K / 32K · 28%', { exact: false })).toBeInTheDocument();
  });
  it('copies the complete session ID and shows feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    open(); fireEvent.click(screen.getByRole('button', { name: 'Copy Session ID' }));
    expect(writeText).toHaveBeenCalledWith('complete-session-id');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Session ID copied' })).toBeInTheDocument());
  });
  it('shows thinking without opening a picker and applies it and model changes immediately', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(commands.setSessionModel).toHaveBeenCalledWith(session.id, 'm1', 'high', undefined);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'm2' } });
    expect(commands.setSessionModel).toHaveBeenCalledWith(session.id, 'm2', undefined);
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });
  it('forks directly but deletion requires confirmation', () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    expect(commands.forkSession).toHaveBeenCalledWith(session.id);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(commands.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(commands.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(close).toHaveBeenCalled();
  });
  it('opens the title editor across the whole row with the full title selected (Mac parity)', () => {
    render(<SessionInfoPanel session={{ ...session, title: 'Call show_report tool for mermaid.html' }} usage={usage} models={['m1']} modelDetails={details} onClose={close} />);
    fireEvent.click(screen.getByText('Call show_report tool for mermaid.html'));
    const input = screen.getByRole('textbox', { name: 'Session title' }) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    expect(input.closest('.ksi-row')).toHaveClass('ksi-row-grow');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Session title' })).not.toBeInTheDocument();
    expect(commands.renameSession).not.toHaveBeenCalled();
  });
});

it('updates session labels, effort choices, durations, tokens and accessibility copy without changing user content', async () => {
  const { i18next } = await import('../../i18n');
  const { act } = await import('@testing-library/react');
  render(<SessionInfoPanel session={{ ...session, title: 'User title' }} usage={usage} models={['m1']} modelDetails={details} onClose={close} />);
  try {
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByRole('heading', { name: '会话信息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制会话 ID' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '上下文用量' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '高' })).toBeInTheDocument();
    expect(screen.getByText('1 分 15 秒')).toBeInTheDocument();
    expect([999, 9100, 32300, 1000000].map(formatTokens)).toEqual(['999', '9.1K', '32K', '1.0M']);
    expect(screen.getByText('$0.0040')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: '推理强度' })).toBeInTheDocument();
    expect(screen.getByText('User title')).toBeInTheDocument();
    expect(screen.getByText('Model One')).toBeInTheDocument();
  } finally { await act(async () => { await i18next.changeLanguage('en'); }); }
});

it('keeps USD notation and precision in Chinese for ordinary costs', async () => {
  const { i18next } = await import('../../i18n');
  const { act } = await import('@testing-library/react');
  try {
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    render(<SessionInfoPanel session={session} usage={{ ...usage, totalCost: .042 }} onClose={close} />);
    expect(screen.getByText('$0.042')).toBeInTheDocument();
  } finally { await act(async () => { await i18next.changeLanguage('en'); }); }
});

it('shows an effort level it has no copy for as the agent reported it, not as a translation key', () => {
  const unknown: ModelDetail[] = [{ ...details[0], supportedReasoningEfforts: ['minimal' as never, 'low'] }];
  render(<SessionInfoPanel session={session} usage={usage} models={['m1']} modelDetails={unknown} onClose={close} />);
  expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['minimal', 'Low']);
});

it('Enter or Escape that confirms an IME candidate in the title neither saves nor closes', () => {
  render(<SessionInfoPanel session={{ ...session, title: 'Old' }} usage={usage} models={['m1']} modelDetails={details} onClose={close} />);
  fireEvent.click(screen.getByText('Old'));
  const input = screen.getByRole('textbox', { name: 'Session title' });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '新标题' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
  expect(commands.renameSession).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Session title' })).toBe(input);
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(commands.renameSession).toHaveBeenCalledWith(session.id, '新标题');
});
