import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NOTICE_SEEN_KEY, performanceNoticeCopy, PerformanceNoticeHost } from './PerformanceNotice';
import { useStore } from '../../hooks/useStore';
import { diag } from '../../lib/diag';
import { i18next } from '../../i18n';

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); useStore.setState({ status: 'connected' }); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await act(async () => { await i18next.changeLanguage('en'); }); });

describe('Performance data notice (Mac PerformanceNotice)', () => {
  it('updates user-visible performance data copy when the language changes', async () => {
    vi.spyOn(diag, 'active', 'get').mockReturnValue(true);
    const set = vi.spyOn(diag, 'setEnabled').mockResolvedValue();
    render(<PerformanceNoticeHost />);
    act(() => vi.advanceTimersByTime(1500));
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByRole('dialog', { name: '帮助改进 Kraki' })).toHaveTextContent('绝不发送消息文本、语音或附件。');
    fireEvent.click(screen.getByRole('button', { name: '不共享' }));
    expect(set).toHaveBeenCalledWith(false);
    expect(localStorage.getItem(NOTICE_SEEN_KEY)).toBe('true');
  });
  it('never appears where performance data does not run (browser)', () => {
    render(<PerformanceNoticeHost />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByTestId('performance-notice')).not.toBeInTheDocument();
  });

  it('shows once after sign-in with the Mac copy; Don\'t Share turns it off and it never returns', () => {
    vi.spyOn(diag, 'active', 'get').mockReturnValue(true);
    const set = vi.spyOn(diag, 'setEnabled').mockResolvedValue();
    const view = render(<PerformanceNoticeHost />);
    expect(screen.queryByTestId('performance-notice')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole('dialog', { name: performanceNoticeCopy().title })).toHaveTextContent(performanceNoticeCopy().explanation);
    fireEvent.click(screen.getByRole('button', { name: "Don't Share" }));
    expect(set).toHaveBeenCalledWith(false);
    expect(localStorage.getItem(NOTICE_SEEN_KEY)).toBe('true');
    view.unmount();
    render(<PerformanceNoticeHost />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByTestId('performance-notice')).not.toBeInTheDocument();
  });

  it('OK keeps sharing on and marks it seen', () => {
    vi.spyOn(diag, 'active', 'get').mockReturnValue(true);
    const set = vi.spyOn(diag, 'setEnabled').mockResolvedValue();
    render(<PerformanceNoticeHost />);
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(set).not.toHaveBeenCalled();
    expect(localStorage.getItem(NOTICE_SEEN_KEY)).toBe('true');
    expect(screen.queryByTestId('performance-notice')).not.toBeInTheDocument();
  });
});
