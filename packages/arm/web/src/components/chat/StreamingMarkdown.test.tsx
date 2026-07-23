import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StreamingMarkdown } from './StreamingMarkdown';

describe('StreamingMarkdown', () => {
  it('renders parsed markdown, not raw markers (complete input)', () => {
    render(<StreamingMarkdown content="hello **world**" />);
    expect(screen.getByText('world')).toBeTruthy();
    expect(screen.queryByText('hello **world**')).toBeNull();
  });

  it('repairs UNCLOSED markdown mid-stream so it renders as structure, not raw', () => {
    // remend closes the **, so half-streamed bold renders as bold.
    render(<StreamingMarkdown content="this is **bold and still streaming" />);
    expect(screen.getByText(/bold and still streaming/)).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('repairs an unclosed inline code span', () => {
    render(<StreamingMarkdown content={'use `useState hook'} />);
    expect(screen.getByText(/useState hook/)).toBeTruthy();
  });

  it('parses a complete code block', () => {
    const { container } = render(<StreamingMarkdown content={'```ts\nconst x = 1;\n```'} />);
    expect(container.querySelector('code')).toBeTruthy();
  });

  it('renders a list', () => {
    render(<StreamingMarkdown content={'- one\n- two'} />);
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('updates content across re-renders (streaming growth)', () => {
    const { rerender } = render(<StreamingMarkdown content="abc" />);
    expect(screen.getByText('abc')).toBeTruthy();
    rerender(<StreamingMarkdown content="abc def **bold**" />);
    expect(screen.getByText('bold')).toBeTruthy();
  });

  it('renders nothing meaningful for empty content', () => {
    const { container } = render(<StreamingMarkdown content="" />);
    expect(container.textContent?.trim()).toBe('');
  });
});
