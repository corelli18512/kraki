import { unreadLanding } from '../../lib/chat/unread-entry';
import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode,
} from 'react';

/**
 * The chat's scroll container. Native browser user scrolling (the platform's own
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
  /** Extra reach below the newest edge while an overlay (the expanded
   *  composer) covers it: it only extends how far the reader can scroll, so
   *  covered bubbles can be lifted by hand. Follow, ↓ and at-bottom still rest
   *  on the newest edge (docs/chat-composer-overlay.md, Mac parity). */
  overlayReach?: number;
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
  /** Side a newly arrived row slides in from (null: no entrance). */
  entranceSide?: (row: Row) => 'left' | 'right' | null;
}

const PIN_THRESHOLD = 4;
/** Layout settling right after a Session opens is applied at once. */
const ENTRY_SETTLE_MS = 400;
/** Bottom-follow time constant: ~95 % of a new line / bubble in ~0.24 s. */
const FOLLOW_TAU_MS = 80;
/** Mac animateScroll's cubic arrival glide, with a live target each frame. */
const NAVIGATION_MS = 280;

/** Fraction of the remaining distance to close after `dt` ms. */
export function followProgress(dt: number): number {
  return 1 - Math.exp(-Math.max(0, Math.min(dt, 64)) / FOLLOW_TAU_MS);
}

/** Arrivals after the previous tail still enter when the front of a capped
 *  window was evicted. If the tail itself disappeared, only net growth enters:
 *  pending → sent and live → landed are identity replacements, not arrivals. */
export function newTailKeys(before: string[], after: string[]): string[] {
  const tail = before.length ? after.indexOf(before[before.length - 1]) : -1;
  const grew = after.length - before.length;
  if (tail < 0 && grew <= 0) return [];
  const known = new Set(before);
  return after.slice(tail >= 0 ? tail + 1 : after.length - grew).filter((key) => !known.has(key));
}
const NEAR_TOP = 900;

function ChatScrollerInner<Row extends ScrollerRow>(
  { rows, renderRow, topInset, bottomInset, overlayReach = 0, header, onAtBottomChange, onNearTop, onScroll, unreadTarget, onUnreadEntryEnd, entranceSide }: Props<Row>,
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

  const reach = useRef(overlayReach);
  reach.current = overlayReach;
  /** scrollTop at the newest edge, excluding the overlay reach. */
  const tailTop = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight - reach.current);

  const reportBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // Following / returning to the tail is a semantic bottom state even while
    // the animation is catching up with new geometry.
    const atBottom = pinned.current || tailTop(el) - el.scrollTop <= PIN_THRESHOLD;
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
    const tail = tailTop(el);
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

  // ── Following the bottom smoothly ──
  // Content arriving at the followed bottom (a streamed line, a new bubble)
  // glides the conversation up instead of jumping in one frame: each frame
  // closes part of the remaining distance, re-targeting as content keeps
  // growing. Entry and layout settling stay instant.
  const following = useRef(false);
  const followFrame = useRef(0);
  const mountedAt = useRef(performance.now());
  // Navigation and follow share a single frame owner. A growing tail must
  // never start direct writes alongside a browser-owned smooth navigation.
  const stopMotion = () => {
    if (followFrame.current) cancelAnimationFrame(followFrame.current);
    followFrame.current = 0;
    following.current = false;
    programmatic.current = false;
  };
  const followBottom = useCallback(() => {
    const el = scroller.current;
    if (!el || following.current || programmatic.current) return;
    following.current = true;
    let last = performance.now();
    const step = (now: number) => {
      const target = tailTop(el);
      const remaining = target - el.scrollTop;
      if (!pinned.current || remaining <= 0.5) {
        // A revealed covered tail (scrolled into the overlay reach) stays revealed.
        if (pinned.current && remaining > 0) el.scrollTop = target;
        stopMotion();
        reportBottom();
        return;
      }
      el.scrollTop += remaining * followProgress(now - last);
      last = now;
      followFrame.current = requestAnimationFrame(step);
    };
    followFrame.current = requestAnimationFrame(step);
  }, [reportBottom]);
  useEffect(() => () => stopMotion(), []);

  /** Re-apply pin / anchor after anything changed geometry. */
  const settle = useCallback((instant = false) => {
    const el = scroller.current;
    if (!el) return;
    if (programmatic.current) {
      // The navigation re-measures its target each frame; settling cannot
      // take over its offset, even for composer / viewport changes.
      reportBottom();
      return;
    }
    if (applyUnreadEntry()) {
      // Held on the first new message.
    } else if (pinned.current) {
      const settling = performance.now() - mountedAt.current < ENTRY_SETTLE_MS;
      if (instant || settling) {
        stopMotion();
        // Rest on the newest edge; keep a revealed covered tail where it is.
        if (el.scrollTop < tailTop(el)) el.scrollTop = tailTop(el);
      } else followBottom();
    } else if (anchor.current) {
      const node = rowElement(anchor.current.key);
      if (node) {
        const top = el.getBoundingClientRect().top + topInset;
        const drift = node.getBoundingClientRect().top - top - anchor.current.offset;
        if (Math.abs(drift) >= 0.5) el.scrollTop += drift;
      }
    }
    reportBottom();
  }, [topInset, reportBottom, applyUnreadEntry, followBottom]);

  // New rows at the end enter from their side (once): not on entry, not
  // older pages, and not a row that only changed identity (sending → sent,
  // streaming → landed), which keeps its place.
  const previousKeys = useRef<string[] | null>(null);
  useLayoutEffect(() => {
    const keys = rows.map((r) => r.key);
    const before = previousKeys.current;
    previousKeys.current = keys;
    if (!before || !entranceSide) return;
    for (const key of newTailKeys(before, keys)) {
      const row = rows.find((r) => r.key === key);
      const side = row ? entranceSide(row) : null;
      const node = side ? rowElement(key) : null;
      if (!node) continue;
      node.classList.remove('kenter-left', 'kenter-right');
      void node.offsetWidth;
      node.classList.add(side === 'left' ? 'kenter-left' : 'kenter-right');
      node.addEventListener('animationend', () => node.classList.remove('kenter-left', 'kenter-right'), { once: true });
    }
  }, [rows, entranceSide]);

  // Rows changed: restore before the browser paints.
  useLayoutEffect(() => { settle(); }, [rows, settle]);
  // The composer changed height: keep the bottom in place at once.
  useLayoutEffect(() => { settle(true); }, [bottomInset, overlayReach, settle]);

  // Size changes inside rows (images, fonts, highlighted code, streaming).
  useLayoutEffect(() => {
    const box = content.current;
    if (!box) return;
    const ro = new ResizeObserver(() => settle());
    ro.observe(box);
    if (scroller.current) ro.observe(scroller.current);
    return () => ro.disconnect();
  }, [settle]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let previousTop = el.scrollTop;
    let previousMax = el.scrollHeight - el.clientHeight;
    let olderIntent = false;
    const onScrollEvent = () => {
      const distance = tailTop(el) - el.scrollTop;
      const max = el.scrollHeight - el.clientHeight;
      // Giving back collapsed overlay reach is a browser clamp, not older
      // intent. It must not disengage a reader who had revealed the tail.
      const clamped = max < previousMax && el.scrollTop >= max - 1;
      if (!programmatic.current && !following.current) {
        // Older movement overrides proximity. Only actual newer movement
        // back into the tail band re-arms follow (not a later settle).
        if (el.scrollTop < previousTop && !clamped) pinned.current = false;
        else if (el.scrollTop > previousTop && !olderIntent) pinned.current = distance <= PIN_THRESHOLD;
      }
      previousTop = el.scrollTop;
      previousMax = max;
      captureAnchor();
      reportBottom();
      if (el.scrollTop < NEAR_TOP) callbacks.current.onNearTop?.();
      callbacks.current.onScroll?.();
    };
    // A user gesture always takes over from a programmatic glide, and from
    // the unread-entry landing.
    const onUser = (older = false, newer = false) => {
      stopMotion();
      endUnreadEntry();
      previousTop = el.scrollTop;
      // A queued scroll from the cancelled animation is not renewed newer
      // intent. Keep an older wheel/key packet authoritative until new input.
      olderIntent = older;
      if (older) pinned.current = false;
      else if (newer && tailTop(el) - el.scrollTop <= PIN_THRESHOLD) pinned.current = true;
      captureAnchor();
      reportBottom();
    };
    const onWheel = (e: WheelEvent) => { onUser(e.deltaY < 0, e.deltaY > 0); };
    const onPointer = () => { onUser(); };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) {
        const older = ['PageUp', 'ArrowUp', 'Home'].includes(e.key) || (e.key === ' ' && e.shiftKey);
        onUser(older, !older);
      }
    };
    el.addEventListener('scroll', onScrollEvent, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onPointer, { passive: true });
    el.addEventListener('pointerdown', onPointer, { passive: true });
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('scroll', onScrollEvent);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onPointer);
      el.removeEventListener('pointerdown', onPointer);
      el.removeEventListener('keydown', onKey);
    };
  }, [captureAnchor, reportBottom]);

  // Open at the newest edge (or the first new message, see settle).
  useLayoutEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = tailTop(el);
    settle();
  }, []);

  const glide = (target: () => number, smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    reportBottom();
    if (!smooth) { el.scrollTop = target(); captureAnchor(); reportBottom(); return; }
    programmatic.current = true;
    const from = el.scrollTop;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / NAVIGATION_MS);
      const top = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, target()));
      el.scrollTop = from + (top - from) * (1 - Math.pow(1 - progress, 3));
      if (progress < 1) followFrame.current = requestAnimationFrame(step);
      else {
        stopMotion();
        captureAnchor();
        reportBottom();
      }
    };
    followFrame.current = requestAnimationFrame(step);
  };

  useImperativeHandle(ref, () => ({
    scrollToBottom: (smooth) => {
      const el = scroller.current;
      if (!el) return;
      stopMotion();
      endUnreadEntry();
      pinned.current = true;
      glide(() => tailTop(el), smooth);
    },
    scrollToRow: (key, smooth) => {
      const el = scroller.current;
      const node = rowElement(key);
      if (!el || !node) return;
      stopMotion();
      endUnreadEntry();
      pinned.current = false;
      glide(() => el.scrollTop + node.getBoundingClientRect().top - (el.getBoundingClientRect().top + topInset + 8), smooth);
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
      <div className="kchat-scroll-content" style={{ paddingTop: topInset, paddingBottom: bottomInset }}>
        {header}
        <div ref={content} className="kchat-scroll-rows">
          {rows.map((row) => (
            <div key={row.key} data-scroll-key={row.key}>{renderRow(row)}</div>
          ))}
        </div>
      </div>
      {overlayReach > 0 && <div className="kchat-overlay-reach" aria-hidden style={{ height: overlayReach }} />}
    </div>
  );
}

export const ChatScroller = memo(forwardRef(ChatScrollerInner)) as <Row extends ScrollerRow>(
  props: Props<Row> & { ref?: React.Ref<ChatScrollerHandle> },
) => ReturnType<typeof ChatScrollerInner>;
