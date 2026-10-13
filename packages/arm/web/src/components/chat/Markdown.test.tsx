import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, StreamingMarkdown } from './Markdown';
import { readFileSync } from 'node:fs';

const chatCss = readFileSync('src/components/chat/chat.css', 'utf8');

const styles = document.createElement('style');
beforeAll(() => { styles.textContent = chatCss; document.head.append(styles); });
afterAll(() => styles.remove());

describe('Markdown — native transcript rendering', () => {
  it.each([Markdown, StreamingMarkdown])('preserves prose and quote soft newlines in final and streamed text', (Component) => {
    const { container } = render(<Component text={'First **bold** line\nSecond `code` line\n\n> Quote one\n> Quote two'} />);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs[0].textContent).toBe('First bold line\nSecond code line');
    expect(paragraphs[1].textContent).toBe('Quote one\nQuote two');
    expect(getComputedStyle(paragraphs[0]).whiteSpace).toBe('pre-wrap');
    expect(getComputedStyle(paragraphs[1]).whiteSpace).toBe('pre-wrap');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('code')).toHaveTextContent('code');
  });

  it('renders a thematic break as literal native text without disabling GFM', () => {
    const { container } = render(<Markdown text={'Above\n\n---\n\n| Name | Value |\n|---|---|\n| Alpha | 123 |'} />);
    expect(screen.getByText('---')).toHaveClass('kmd-native-rule');
    expect(container.querySelector('hr')).toBeNull();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
  });

  it('uses native syntax colors and preserves fence whitespace', () => {
    const { container } = render(<Markdown text={'```python\ndef hello(name):\n    print("Hello", name)\n```'} />);
    const code = container.querySelector('pre code')!;
    expect(code.textContent).toBe('def hello(name):\n    print("Hello", name)\n');
    expect(getComputedStyle(code.querySelector('.hljs-keyword')!).color).toBe('rgb(201, 209, 217)');
    expect(getComputedStyle(code.querySelector('.hljs-title')!).color).toBe('rgb(201, 209, 217)');
    expect(getComputedStyle(code.querySelector('.hljs-built_in')!).color).toBe('rgb(255, 166, 87)');
    expect(getComputedStyle(code.querySelector('.hljs-string')!).color).toBe('rgb(165, 214, 255)');
    expect(getComputedStyle(container.querySelector('pre')!).whiteSpace).toBe('pre');
  });
});
