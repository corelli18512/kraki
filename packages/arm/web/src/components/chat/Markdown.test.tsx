import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, StreamingMarkdown } from './Markdown';
import { readFileSync } from 'node:fs';

const chatCss = readFileSync('src/components/chat/chat.css', 'utf8');

const styles = document.createElement('style');
beforeAll(() => { styles.textContent = chatCss; document.head.append(styles); });
afterAll(() => styles.remove());

// jsdom reports the literal `inherit`; Chromium resolves this in verify.mjs.
function resolvedColor(element: Element): string {
  const color = getComputedStyle(element).color;
  return color === 'inherit' && element.parentElement ? resolvedColor(element.parentElement) : color;
}

describe('Markdown — native transcript rendering', () => {
  it.each([Markdown, StreamingMarkdown])('preserves prose and quote soft newlines in final and streamed text', (Component) => {
    const { container } = render(<Component text={'First **bold** line\nSecond `code` line\n\n> Quote one\n> Quote two'} />);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs[0].textContent).toBe('First bold line\nSecond code line');
    expect(paragraphs[1].textContent).toBe('Quote one\nQuote two');
    expect(getComputedStyle(paragraphs[0]).whiteSpace).toBe('pre-wrap');
    expect(getComputedStyle(paragraphs[1]).whiteSpace).toBe('pre-wrap');
    expect(getComputedStyle(paragraphs[0].parentElement!).lineHeight).toBe('18px');
    expect(getComputedStyle(paragraphs[1]).lineHeight).toBe('19px');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('code')).toHaveTextContent('code');
  });

  it.each(['First  \nSecond', 'First\\\nSecond'])('keeps hard breaks to a single preserved newline (%s)', (text) => {
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector('p')!.textContent).toBe('First\nSecond');
    expect(container.querySelector('br')).toBeNull();
  });

  it('renders a thematic break as literal native text without disabling GFM', () => {
    const { container } = render(<Markdown text={'Above\n\n---\n\n| Name | Value |\n|---|---|\n| Alpha | 123 |'} />);
    expect(screen.getByText('---')).toHaveClass('kmd-native-rule');
    expect(container.querySelector('hr')).toBeNull();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
    const table = container.querySelector<HTMLElement>('.ktable')!;
    // Chromium's border width is checked in the paired-browser validation;
    // jsdom exposes an empty borderStyle for the shorthand `border: none`.
    expect(getComputedStyle(table).borderRadius).toBe('0');
    expect(getComputedStyle(table.querySelector('th')!).borderTopLeftRadius).toBe('10px');
  });

  it('uses 18pt unordered depth independently of 25pt ordered markers', () => {
    const { container } = render(<Markdown text={'- Alpha\n  - Beta\n\n1. One\n   1. Two\n      - Three'} />);
    const lists = container.querySelectorAll('ul, ol');
    expect([...lists].map((list) => getComputedStyle(list).paddingLeft)).toEqual(['18px', '18px', '25px', '25px', '18px']);
    expect(getComputedStyle(lists[3]).marginLeft).toBe('-7px');
    expect(getComputedStyle(lists[4]).marginLeft).toBe('-7px');
    for (const li of container.querySelectorAll('li')) expect(getComputedStyle(li).paddingLeft).toBe('0px');
    expect(chatCss).toContain('color: var(--color-label-secondary);');
  });

  it('uses native syntax colors and preserves fence whitespace', () => {
    const { container } = render(<Markdown text={'```python\ndef hello(name):\n    print("Hello", name)\n```'} />);
    const code = container.querySelector('pre code')!;
    expect(code.textContent).toBe('def hello(name):\n    print("Hello", name)\n');
    expect(resolvedColor(code.querySelector('.hljs-keyword')!)).toBe('rgb(201, 209, 217)');
    expect(resolvedColor(code.querySelector('.hljs-title')!)).toBe('rgb(201, 209, 217)');
    expect(getComputedStyle(code.querySelector('.hljs-built_in')!).color).toBe('rgb(255, 166, 87)');
    expect(getComputedStyle(code.querySelector('.hljs-string')!).color).toBe('rgb(165, 214, 255)');
    expect(getComputedStyle(container.querySelector('pre')!).whiteSpace).toBe('pre');
  });
});
