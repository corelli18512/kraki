import { memo, useDeferredValue, useMemo } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import remend from 'remend';
import { markdownComponents } from './MessageBubble';

/**
 * Streaming-aware markdown renderer for the live status-card draft.
 *
 * Approach copied from Vercel's `streamdown` (the production-grade streaming
 * markdown renderer behind v0 / AI SDK), distilled to the parts that matter
 * here so we keep our existing react-markdown + rehype-highlight + styling:
 *
 *  1. `remend` preprocesses the (possibly partial) markdown before parsing:
 *     it auto-closes unterminated `**`, `` ` ``, `~~`, `[link](`, `$$`… so the
 *     in-flight text never flashes raw markers mid-stream. Pure function, zero
 *     deps. This is the core thing that makes streaming markdown "just work".
 *
 *  2. `useDeferredValue` feeds the parser a lower-priority copy of the text, so
 *     an urgent token-arrival renders immediately (React reuses the previous
 *     parsed tree) and the heavier remark + rehype-highlight re-parse runs in
 *     idle time instead of blocking input/animation frames. Markdown keeps
 *     rendering throughout the stream (never degrades to raw text); on slow
 *     hardware it just lags a few frames under load.
 *
 *  3. The whole thing is `memo`'d so a parent re-render (e.g. the action slot
 *     updating) does not re-parse the draft.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ content }: { content: string }) {
  const deferred = useDeferredValue(content);
  const repaired = useMemo(() => remend(deferred), [deferred]);
  return (
    <div className="streaming-cursor">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
        {repaired}
      </Markdown>
    </div>
  );
});
