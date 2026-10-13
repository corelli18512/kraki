import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';
import { MessageBubble } from './MessageBubble';

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
