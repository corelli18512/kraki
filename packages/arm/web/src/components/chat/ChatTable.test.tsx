import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Markdown } from './Markdown';
import { isNumericColumn, isNumericCell } from './ChatTable';

const big = ['| Name | Count | Note |', '|---|---|---|', ...Array.from({ length: 12 }, (_, i) => `| item ${i} | ${(12 - i) * 10} | **bold** \`code\` |`)].join('\n');

describe('ChatTable (Mac/iOS chat table design)', () => {
  it('detects numeric columns like ChatTable.isNumericColumn', () => {
    expect(isNumericCell('1,234')).toBe(true);
    expect(isNumericCell('12 ms')).toBe(true);
    expect(isNumericCell('$9.99')).toBe(true);
    expect(isNumericCell('v1.2.3')).toBe(false);
    expect(isNumericColumn(['1', '2', '—', 'n/a', '4'])).toBe(true);
    expect(isNumericColumn(['1', 'two', 'three'])).toBe(false);
  });

  it('previews 8 rows with a footer, right-aligns numbers and renders cell Markdown', () => {
    render(<Markdown text={big} />);
    const table = screen.getByTestId('chat-table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);
    expect(within(table).getByText('Showing 8 of 12 rows · 3 columns')).toBeInTheDocument();
    const count = within(table).getByText('120');
    expect(count.closest('td')).toHaveStyle({ textAlign: 'right' });
    expect(within(table).getAllByText('bold')[0].tagName).toBe('STRONG');
    expect(within(table).getAllByText('code')[0].tagName).toBe('CODE');
  });

  it('opens the full table; a header click sorts, search finds cells', () => {
    render(<Markdown text={big} />);
    fireEvent.click(screen.getByText('Open table'));
    const win = screen.getByTestId('table-window');
    expect(within(win).getAllByRole('row')).toHaveLength(1 + 12);
    fireEvent.click(within(win).getByText('Count'));
    const firstCount = () => within(win).getAllByRole('row')[1].querySelectorAll('td')[1].textContent;
    expect(firstCount()).toBe('10');
    fireEvent.click(within(win).getByText('Count'));
    expect(firstCount()).toBe('120');
    fireEvent.change(within(win).getByPlaceholderText('Search'), { target: { value: 'item 1' } });
    expect(within(win).getByText('1 of 3')).toBeInTheDocument();
  });

  it('a small table has no footer', () => {
    render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(screen.queryByText('Open table')).toBeNull();
  });
});
