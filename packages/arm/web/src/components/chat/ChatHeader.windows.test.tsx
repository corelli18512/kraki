import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChatHeader, HEADER_HEIGHT } from './ChatHeader';

vi.mock('../../lib/desktop', () => ({ hasWindowsTitleBar: true }));
afterEach(() => vi.useRealTimers());

describe('ChatHeader Windows native titlebar', () => {
  it('keeps the title action, left separator and existing transcript inset without DOM caption buttons', () => {
    const onTitle = vi.fn();
    const { container } = render(<ChatHeader title="A long session title" mode="auto" narrow={false} onTitle={onTitle} onMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'A long session title' }));
    expect(onTitle).toHaveBeenCalledOnce();
    expect(container.querySelector('header')).toHaveClass('is-windows');
    expect(container.querySelector('.khead-separator')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(HEADER_HEIGHT).toEqual({ wide: 56, narrow: 64 });
  });

  it('opens a persistent dropdown, uses the real mode callback and restores focus on selection', () => {
    vi.useFakeTimers();
    const onMode = vi.fn();
    render(<ChatHeader title="Session" mode="auto" narrow={false} onMode={onMode} />);
    const trigger = screen.getByRole('button', { name: 'Session mode, Auto' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Auto/ })).toHaveFocus();
    expect(screen.getByText('Run tools without asking')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Delegate/ }));
    expect(onMode).toHaveBeenCalledWith('delegate');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('supports keyboard navigation, Escape, outside dismissal and checked-mode no-op', () => {
    const onMode = vi.fn();
    render(<><ChatHeader title="Session" mode="auto" narrow={false} onMode={onMode} /><button>Outside</button></>);
    const trigger = screen.getByRole('button', { name: 'Session mode, Auto' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('menuitemradio', { name: /Safe/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitemradio', { name: /Delegate/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: /Safe/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('menuitemradio', { name: /Delegate/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }));
    expect(onMode).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('retains Back navigation when Windows page zoom enters the narrow layout', () => {
    const onBack = vi.fn();
    render(<ChatHeader title="Session" mode="safe" narrow onBack={onBack} backBadge={3} onMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Session mode, Safe' }));
    expect(screen.getByRole('menuitemradio', { name: /Safe/ })).toHaveAttribute('aria-checked', 'true');
  });
});
