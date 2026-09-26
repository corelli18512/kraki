import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode,
} from 'react';

/**
 * The chat's scroll container. Native browser scrolling (the platform's own
 * physics on every OS), with the two guarantees the iOS/Mac lists make:
 *
 * - Pinned: a reader at the newest edge stays exactly there while the tail
 *   grows (streaming, a reply landing, an image loading).
 * - Anchored: otherwise, the row the reader is looking at does not move on
 *   screen when rows are prepended (older pages) or rows above it change
 *   size. The correction is applied in the same frame (layout effect /
 *   ResizeObserver, both before paint), so there is no one-frame jump.
 *
 * Rows render in document order; the parent decides how many (window).
 */

export interface ScrollerRow {
  key: string;
}

export interface ChatScrollerHandle {
  scrollToBottom: (smooth: boolean) => void;
  /** Bring a row's top just under the header. */
  scrollToRow: (key: string, smooth: boolean) => void;
  /** Topmost row whose top is above the visible area, walking up from it. */
  rowsAbove: () => string[];
  element: () => HTMLDivElement | null;
}

interface Props<Row extends ScrollerRow> {
  rows: Row[];
  renderRow: (row: Row) => ReactNode;
  /** Space covered by the floating header / composer. */
  topInset: number;
  bottomInset: number;
  header?: ReactNode;
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Near the oldest rendered row (load / reveal older). */
  onNearTop?: () => void;
  onScroll?: () => void;
}

const PIN_THRESHOLD = 4;
const NEAR_TOP = 900;

function ChatScrollerInner<Row extends ScrollerRow>(
  { rows, renderRow, topInset, bottomInset, header, onAtBottomChange, onNearTop, onScroll }: Props<Row>,
  ref: React.Ref<ChatScrollerHandle>,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const lastBottom = useRef<boolean | null>(null);
  const programmatic = useRef(false);
  const callbacks = useRef({ onAtBottomChange, onNearTop, onScroll });
  callbacks.current = { onAtBottomChange, onNearTop, onScroll };

  const rowElement = (key: string) =>
    content.current?.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(key)}"]`) ?? null;

  /** Remember the first row whose bottom is below the visible top. */
  const captureAnchor = useCallback(() => {
    const el = scroller.current;
    const box = content.current;
    if (!el || !box) return;
    const top = el.getBoundingClientRect().top + topInset;
    for (const child of box.children as HTMLCollectionOf<HTMLElement>) {
      const r = child.getBoundingClientRect();
      if (r.bottom > top) {
        anchor.current = { key: child.dataset.scrollKey ?? '', offset: r.top - top };
        return;
      }
    }
    anchor.current = null;
  }, [topInset]);

  const reportBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
    if (atBottom !== lastBottom.current) {
      lastBottom.current = atBottom;
      callbacks.current.onAtBottomChange?.(atBottom);
    }
  }, []);

  /** Re-apply pin / anchor after anything changed geometry. */
  const settle = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const node = rowElement(anchor.current.key);
      if (node) {
        const top = el.getBoundingClientRect().top + topInset;
        const drift = node.getBoundingClientRect().top - top - anchor.current.offset;
        if (Math.abs(drift) >= 0.5) el.scrollTop += drift;
      }
    }
    reportBottom();
  }, [topInset, reportBottom]);

  // Rows changed: restore before the browser paints.
  useLayoutEffect(() => { settle(); }, [rows, bottomInset, settle]);

  // Size changes inside rows (images, fonts, highlighted code, streaming).
  useLayoutEffect(() => {
    const box = content.current;
    if (!box) return;
    const ro = new ResizeObserver(() => settle());
    ro.observe(box);
    return () => ro.disconnect();
  }, [settle]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScrollEvent = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (!programmatic.current) pinned.current = distance <= PIN_THRESHOLD;
      captureAnchor();
      reportBottom();
      if (el.scrollTop < NEAR_TOP) callbacks.current.onNearTop?.();
      callbacks.current.onScroll?.();
    };
    // A user gesture always takes over from a programmatic glide.
    const onUser = () => { programmatic.current = false; };
    el.addEventListener('scroll', onScrollEvent, { passive: true });
    el.addEventListener('wheel', onUser, { passive: true });
    el.addEventListener('touchstart', onUser, { passive: true });
    el.addEventListener('pointerdown', onUser, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScrollEvent);
      el.removeEventListener('wheel', onUser);
      el.removeEventListener('touchstart', onUser);
      el.removeEventListener('pointerdown', onUser);
    };
  }, [captureAnchor, reportBottom]);

  // Open at the newest edge.
  useLayoutEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const glide = (top: number, smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    if (!smooth) { el.scrollTop = top; return; }
    programmatic.current = true;
    el.scrollTo({ top, behavior: 'smooth' });
    const done = () => { programmatic.current = false; el.removeEventListener('scrollend', done); captureAnchor(); };
    el.addEventListener('scrollend', done);
    setTimeout(done, 900);
  };

  useImperativeHandle(ref, () => ({
    scrollToBottom: (smooth) => {
      const el = scroller.current;
      if (!el) return;
      pinned.current = true;
      glide(el.scrollHeight, smooth);
    },
    scrollToRow: (key, smooth) => {
      const el = scroller.current;
      const node = rowElement(key);
      if (!el || !node) return;
      pinned.current = false;
      const delta = node.getBoundingClientRect().top - (el.getBoundingClientRect().top + topInset + 8);
      glide(el.scrollTop + delta, smooth);
      anchor.current = { key, offset: 8 };
    },
    rowsAbove: () => {
      const el = scroller.current;
      const box = content.current;
      if (!el || !box) return [];
      const top = el.getBoundingClientRect().top + topInset + 4;
      const keys: string[] = [];
      for (const child of box.children as HTMLCollectionOf<HTMLElement>) {
        if (child.getBoundingClientRect().top >= top) break;
        keys.push(child.dataset.scrollKey ?? '');
      }
      return keys;
    },
    element: () => scroller.current,
  }));

  return (
    <div ref={scroller} className="kchat-list" data-chat-scroll style={{ overflowAnchor: 'none' }}>
      <div style={{ paddingTop: topInset }}>{header}</div>
      <div ref={content}>
        {rows.map((row) => (
          <div key={row.key} data-scroll-key={row.key}>{renderRow(row)}</div>
        ))}
      </div>
      <div style={{ height: bottomInset }} aria-hidden />
    </div>
  );
}

export const ChatScroller = memo(forwardRef(ChatScrollerInner)) as <Row extends ScrollerRow>(
  props: Props<Row> & { ref?: React.Ref<ChatScrollerHandle> },
) => ReturnType<typeof ChatScrollerInner>;
