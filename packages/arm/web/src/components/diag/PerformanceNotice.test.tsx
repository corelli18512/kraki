import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NOTICE_SEEN_KEY, PERFORMANCE_NOTICE, PerformanceNoticeHost } from './PerformanceNotice';
import { useStore } from '../../hooks/useStore';
import { diag } from '../../lib/diag';

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); useStore.setState({ status: 'connected' }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Performance data notice (Mac PerformanceNotice)', () => {
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
    expect(screen.getByRole('dialog', { name: PERFORMANCE_NOTICE.title })).toHaveTextContent(PERFORMANCE_NOTICE.explanation);
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
