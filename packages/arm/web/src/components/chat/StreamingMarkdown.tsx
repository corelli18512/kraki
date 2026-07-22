import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from './MessageBubble';

/**
 * Streaming-aware markdown renderer for the live status-card draft.
 *
 * Problem: react-markdown re-parses the ENTIRE accumulated string on every
 * delta (remark + rehype-highlight are O(content length)). Over a long
 * narration the draft grows monotonically, so each 40ms delta flush re-runs a
 * full parse of the growing document — O(n²) over the turn — which drops frames
 * on real hardware and makes the text feel janky (it lands in bursts instead
 * of flowing).
 *
 * Fix: while deltas are still arriving, render the raw text cheaply (escaped,
 * whitespace-preserved, with a blinking cursor) so every token paints in the
 * same frame it arrives. Only when the stream settles for `settleMs` (no new
 * text) do we run the full markdown parse — once, on the now-stable content.
 * The concluding agent_message already swaps to a permanent markdown bubble, so
 * this parse is mainly to surface structure (headings/code) during a brief
 * mid-stream pause; it never re-runs per-token.
 *
 * Net cost during active streaming: a single text node update per delta instead
 * of a full AST rebuild + syntax re-highlight.
 */
export function StreamingMarkdown({ content }: { content: string }) {
  const [parsed, setParsed] = useState<string | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLen = useRef(0);

  useEffect(() => {
    // Clear any pending parse-on-settle when content changes.
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }

    if (content.length === 0) {
      setParsed(null);
      lastLen.current = 0;
      return;
    }

    // If the stream reset to a shorter string (new narration segment) or is
    // actively growing, defer the expensive parse until it settles.
    const growing = content.length >= lastLen.current;
    lastLen.current = content.length;

    settleTimer.current = setTimeout(() => {
      setParsed(content);
    }, SETTLE_MS);

    return () => {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
    };
  }, [content]);

  // Render parsed markdown when we have a settled parse for this content;
  // otherwise render the raw text cheaply so tokens paint immediately.
  if (parsed === content && parsed.length > 0) {
    return (
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
        {content}
      </Markdown>
    );
  }

  return <RawDraft text={content} />;
}

/** Cheap live text: escaped, whitespace preserved, trailing streaming cursor. */
function RawDraft({ text }: { text: string }) {
  return (
    <span className="streaming-cursor whitespace-pre-wrap break-words">{text}</span>
  );
}

/** How long the stream must be idle before we run the (one-time) full parse. */
const SETTLE_MS = 350;
