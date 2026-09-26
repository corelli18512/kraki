import { memo, useDeferredValue, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import remend from 'remend';

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/** Markdown elements styled like the native bubbles (see chat.css `.kmd`). */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  // Fenced code: a dark card with the language label, horizontally scrollable.
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const className = (child as { props?: { className?: string } } | undefined)?.props?.className ?? '';
    const language = /language-([\w+-]+)/.exec(className)?.[1];
    return (
      <div className="kmd-code" data-language={language ?? ''}>
        {language && <div className="kmd-code-lang">{language}</div>}
        <pre>{children}</pre>
      </div>
    );
  },
  table: ({ children }) => (
    <div className="kmd-table"><table>{children}</table></div>
  ),
  input: ({ checked, type }) => (type === 'checkbox'
    ? <span className="kmd-check" aria-checked={!!checked} role="checkbox">{checked ? '☑' : '☐'}</span>
    : null),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="kmd">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A streaming draft: `remend` closes unterminated markers so partial text
 * never flashes raw syntax, and `useDeferredValue` lets a token arrival
 * render at once while the heavier re-parse runs at lower priority.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const deferred = useDeferredValue(text);
  const repaired = useMemo(() => remend(deferred), [deferred]);
  return <Markdown text={repaired} />;
});

export { textOf };
