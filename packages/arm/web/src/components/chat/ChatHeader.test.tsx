import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChatHeader } from './ChatHeader';

afterEach(() => vi.useRealTimers());

describe('ChatHeader desktop mode picker', () => {
  it('expands inline, selects without closing, and collapses after three seconds', () => {
    vi.useFakeTimers();
    const onMode = vi.fn();
    render(<ChatHeader title="Session" mode="auto" narrow={false} onMode={onMode} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session mode, Auto' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
    expect(screen.queryByText('Run tools without asking')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Safe' }));
    expect(onMode).toHaveBeenCalledWith('safe');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('hides the title while the mode segments are expanded, as on Mac', () => {
    render(<ChatHeader title="A long session title" mode="auto" narrow={false} onMode={vi.fn()} />);
    const title = screen.getByTitle('Session details');
    expect(title).not.toHaveClass('is-hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Session mode, Auto' }));
    expect(title).toHaveClass('is-hidden');
    expect(title).toHaveAttribute('aria-hidden', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(title).not.toHaveClass('is-hidden');
  });

  it('pauses collapse on hover and restarts on exit', () => {
    vi.useFakeTimers();
    const { container } = render(<ChatHeader title="Session" mode="auto" narrow={false} onMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session mode, Auto' }));
    const picker = container.querySelector('.khead-mode')!;
    fireEvent.mouseEnter(picker);
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseLeave(picker);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('retains the narrow layout dropdown', () => {
    render(<ChatHeader title="Session" mode="auto" narrow onMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session mode, Auto' }));
    expect(screen.getByText('Run tools without asking')).toBeInTheDocument();
  });
});
