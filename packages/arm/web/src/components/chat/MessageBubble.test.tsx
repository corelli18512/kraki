import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';
import { LONG_PRESS_MS, MessageBubble } from './MessageBubble';

function setup(onShowSteps?: () => void, text = 'Hello **world**.\nSecond line.') {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { container } = render(<MessageBubble className="kbubble" onShowSteps={onShowSteps}><Markdown text={text} /></MessageBubble>);
  return { bubble: container.querySelector<HTMLElement>('.kbubble')!, writeText };
}

afterEach(() => { window.getSelection()?.removeAllRanges(); });

describe('MessageBubble — native context actions', () => {
  it('copies rendered prose, not Markdown markers, with no permanent copy control', () => {
    const { bubble, writeText } = setup();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(bubble, { clientX: 100, clientY: 150 });
    expect(screen.queryByRole('menuitem', { name: 'Show Steps' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Hello world.\nSecond line.');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('preserves a selection and copies only it', () => {
    const { bubble, writeText } = setup();
    const range = document.createRange();
    range.selectNodeContents(bubble.querySelector('strong')!);
    window.getSelection()?.addRange(range);
    fireEvent.contextMenu(bubble);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Selection' }));
    expect(writeText).toHaveBeenCalledWith('world');
  });

  it('ignores selections from a different message', () => {
    const { bubble, writeText } = setup();
    const other = document.createTextNode('Other message');
    document.body.append(other);
    const range = document.createRange();
    range.selectNodeContents(other);
    window.getSelection()?.addRange(range);
    fireEvent.contextMenu(bubble);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Hello world.\nSecond line.');
    other.remove();
  });

  it('opens and navigates by keyboard; Copy precedes Show Steps and Escape restores focus', () => {
    const onShowSteps = vi.fn();
    const { bubble } = setup(onShowSteps);
    bubble.focus();
    fireEvent.keyDown(bubble, { key: 'F10', shiftKey: true });
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Copy', 'Show Steps']);
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(bubble).toHaveFocus();
    fireEvent.contextMenu(bubble);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show Steps' }));
    expect(onShowSteps).toHaveBeenCalledOnce();
  });

  it('dismisses on outside click and scroll', () => {
    const { bubble } = setup();
    fireEvent.contextMenu(bubble);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(bubble);
    fireEvent.scroll(document);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('copies all table rows, including those hidden by the preview', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `| item ${i} | ${i} |`);
    const { bubble, writeText } = setup(undefined, ['| Name | Value |', '|---|---|', ...rows].join('\n'));
    expect(screen.queryByText('item 11')).toBeNull();
    fireEvent.contextMenu(bubble);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(['Name\tValue', ...rows.map((_, i) => `item ${i}\t${i}`)].join('\n'));
  });

  it('omits fence labels and table chrome from copied text', () => {
    const { bubble, writeText } = setup(undefined, '```python\nprint("Hello")\n```\n\n| Name | Value |\n|---|---|\n| Alpha | 123 |');
    fireEvent.contextMenu(bubble);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('print("Hello")\n\nName\tValue\nAlpha\t123');
  });
});

describe('MessageBubble — touch long press (K-107) and code blocks (K-237)', () => {
  // jsdom has no PointerEvent.
  class TestPointerEvent extends MouseEvent {
    pointerId: number; pointerType: string; isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'mouse'; this.isPrimary = init.isPrimary ?? true;
    }
  }
  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
  });
  const touch = { pointerId: 7, pointerType: 'touch', isPrimary: true };

  it('a resting long press opens the menu (iOS Safari fires no contextmenu)', () => {
    const onShowSteps = vi.fn();
    const { bubble, writeText } = setup(onShowSteps);
    fireEvent.pointerDown(bubble, { ...touch, clientX: 50, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 1); });
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy', 'Show Steps']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Hello world.\nSecond line.');
  });

  it("copies the whole message, not the word the long press selected", () => {
    const { bubble, writeText } = setup();
    fireEvent.pointerDown(bubble, { ...touch, clientX: 50, clientY: 60 });
    const range = document.createRange();
    range.selectNodeContents(bubble.querySelector('strong')!);
    window.getSelection()?.addRange(range);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Hello world.\nSecond line.');
  });

  it('lifting after the long press does not send the mouse events that would close the menu', () => {
    const { bubble } = setup();
    fireEvent.pointerDown(bubble, { ...touch, clientX: 50, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fireEvent.pointerUp(bubble, touch);
    // fireEvent returns false when the default (compatibility mouse events) was prevented.
    expect(fireEvent.touchEnd(bubble)).toBe(false);
    expect(screen.getByRole('menu')).toBeTruthy();
    // A plain tap keeps its click.
    fireEvent.pointerDown(bubble, { ...touch, clientX: 50, clientY: 60 });
    fireEvent.pointerUp(bubble, touch);
    expect(fireEvent.touchEnd(bubble)).toBe(true);
  });

  it('a scroll, a lift or a mouse press opens nothing', () => {
    const { bubble } = setup();
    fireEvent.pointerDown(bubble, { ...touch, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(bubble, { ...touch, clientX: 50, clientY: 90 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fireEvent.pointerDown(bubble, { ...touch, clientX: 50, clientY: 60 });
    fireEvent.pointerUp(bubble, touch);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: 'mouse', clientX: 50, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('over a code block the menu also copies just the code', () => {
    const { bubble, writeText } = setup(undefined, 'Run this:\n\n```sh\npnpm install\npnpm test\n```');
    fireEvent.pointerDown(bubble.querySelector('code')!, { ...touch, clientX: 50, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy', 'Copy Code']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Code' }));
    expect(writeText).toHaveBeenCalledWith('pnpm install\npnpm test');
    // A right click: on the code it offers the code, on prose it does not.
    fireEvent.contextMenu(bubble.querySelector('pre')!);
    expect(screen.getByRole('menuitem', { name: 'Copy Code' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    fireEvent.contextMenu(bubble.querySelector('p')!);
    expect(screen.queryByRole('menuitem', { name: 'Copy Code' })).toBeNull();
  });
});
