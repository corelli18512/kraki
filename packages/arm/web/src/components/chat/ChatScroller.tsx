import { unreadLanding } from '../../lib/chat/unread-entry';
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
  /** Entered with new messages: the first new row's key (see unread-entry.ts).
   *  Read on every settle until the reader scrolls, ↓ or sends. */
  unreadTarget?: string | null;
  /** Called when the reader takes over (the landing no longer applies). */
  onUnreadEntryEnd?: () => void;
}

const PIN_THRESHOLD = 4;
const NEAR_TOP = 900;

function ChatScrollerInner<Row extends ScrollerRow>(
  { rows, renderRow, topInset, bottomInset, header, onAtBottomChange, onNearTop, onScroll, unreadTarget, onUnreadEntryEnd }: Props<Row>,
  ref: React.Ref<ChatScrollerHandle>,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const lastBottom = useRef<boolean | null>(null);
  const programmatic = useRef(false);
  const callbacks = useRef({ onAtBottomChange, onNearTop, onScroll, onUnreadEntryEnd });
  callbacks.current = { onAtBottomChange, onNearTop, onScroll, onUnreadEntryEnd };
  /** none | armed (following while it fits) | anchored (held at the top). */
  const unread = useRef<'none' | 'armed' | 'anchored'>(unreadTarget !== undefined ? 'armed' : 'none');
  const unreadTargetRef = useRef(unreadTarget ?? null);
  unreadTargetRef.current = unreadTarget ?? null;
  const endUnreadEntry = () => {
    if (unread.current === 'none') return;
    unread.current = 'none';
    callbacks.current.onUnreadEntryEnd?.();
  };

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

  /** Unread entry: land on (or keep) the first new row's start under the
   *  header when it isn't readable at the newest edge. True when it applied. */
  const applyUnreadEntry = useCallback((): boolean => {
    const el = scroller.current;
    const key = unreadTargetRef.current;
    if (!el || unread.current === 'none' || !key) return false;
    const node = rowElement(key);
    if (!node) return false;
    const tail = el.scrollHeight - el.clientHeight;
    const rowStart = el.scrollTop + node.getBoundingClientRect().top - (el.getBoundingClientRect().top + topInset + 8);
    const landing = unreadLanding(Math.max(0, Math.min(tail, rowStart)), tail);
    if (landing === null) {
      // Fits (again, with real heights): follow the newest edge.
      if (unread.current === 'anchored') { unread.current = 'armed'; pinned.current = true; }
      return false;
    }
    unread.current = 'anchored';
    pinned.current = false;
    if (Math.abs(el.scrollTop - landing) >= 0.5) el.scrollTop = landing;
    anchor.current = { key, offset: 8 };
    return true;
  }, [topInset]);

  /** Re-apply pin / anchor after anything changed geometry. */
  const settle = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (applyUnreadEntry()) {
      // Held on the first new message.
    } else if (pinned.current) {
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
  }, [topInset, reportBottom, applyUnreadEntry]);

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
    // A user gesture always takes over from a programmatic glide, and from
    // the unread-entry landing.
    const onUser = () => { programmatic.current = false; endUnreadEntry(); };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) onUser();
    };
    el.addEventListener('scroll', onScrollEvent, { passive: true });
    el.addEventListener('wheel', onUser, { passive: true });
    el.addEventListener('touchstart', onUser, { passive: true });
    el.addEventListener('pointerdown', onUser, { passive: true });
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('scroll', onScrollEvent);
      el.removeEventListener('wheel', onUser);
      el.removeEventListener('touchstart', onUser);
      el.removeEventListener('pointerdown', onUser);
      el.removeEventListener('keydown', onKey);
    };
  }, [captureAnchor, reportBottom]);

  // Open at the newest edge (or the first new message, see settle).
  useLayoutEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    settle();
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
      endUnreadEntry();
      pinned.current = true;
      glide(el.scrollHeight, smooth);
    },
    scrollToRow: (key, smooth) => {
      const el = scroller.current;
      const node = rowElement(key);
      if (!el || !node) return;
      endUnreadEntry();
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
