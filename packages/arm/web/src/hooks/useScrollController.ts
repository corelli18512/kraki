/**
 * useScrollController — owns ALL scroll-position logic for ChatView.
 *
 * Design principles:
 *   1. Every el.scrollTop write happens in useLayoutEffect (before paint → no flicker).
 *   2. useEffect only updates React state (unreadCount, showScrollBtn).
 *   3. ctx.sticky is written ONLY by handleScroll — effects only read it.
 *   4. Priority chain in the layout effect: first matching rule wins.
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import type { RefObject } from 'react';
import type { GroupedMessages } from './useTurns';
import type { ChatMessage } from '../types/store';
import { messageProvider } from '../lib/message-provider';
import { createLogger } from '../lib/logger';

const logger = createLogger('scroll-ctrl');

const BOTTOM_STICKY_THRESHOLD_PX = 40;
const GAP_LOAD_TOP_THRESHOLD_PX = 200;
const IDLE_SCROLL_OVERFLOW_PX = 120;

// ── Helpers ─────────────────────────────────────────────

function getSeq(m: ChatMessage): number {
  return 'seq' in m ? (m as { seq?: number }).seq ?? 0 : 0;
}

function getLastSeq(grouped: GroupedMessages[]): number {
  const last = grouped[grouped.length - 1];
  if (!last) return 0;
  if (last.type === 'standalone') return getSeq(last.message);
  const deepest = last.turn.finalMessage ?? last.turn.thinkingMessages.at(-1);
  return deepest ? getSeq(deepest) : 0;
}

function lastGroupIsFromUser(grouped: GroupedMessages[]): boolean {
  const last = grouped[grouped.length - 1];
  return !!last && last.type === 'standalone' && (
    last.message.type === 'user_message' ||
    last.message.type === 'pending_input' ||
    last.message.type === 'send_input' ||
    last.message.type === 'answer'
  );
}

function lastGroupHasFinal(grouped: GroupedMessages[]): boolean {
  const last = grouped[grouped.length - 1];
  return !!(last?.type === 'turn' && last.turn.finalMessage);
}

/** Try to scroll a target element to the top of the container with 12px breathing room.
 *  Returns true if the target was far enough from the bottom to warrant anchoring. */
function scrollToTarget(el: HTMLElement): boolean {
  const target = el.querySelector<HTMLElement>('[data-scroll-target]');
  if (!target) return false;

  const targetTop = target.offsetTop;
  const contentBelow = el.scrollHeight - targetTop;

  if (contentBelow > el.clientHeight + IDLE_SCROLL_OVERFLOW_PX) {
    target.scrollIntoView({ block: 'start' });
    el.scrollTop = Math.max(0, el.scrollTop - 12);
    return true;
  }
  return false;
}

function scrollToMax(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

// ── Scroll context (single ref replaces 13 scattered refs) ──

interface ScrollCtx {
  // Core
  sticky: boolean;

  // Session entry
  entryPending: boolean;
  entryHadUnread: boolean;

  // Prepend tracking
  prepended: boolean;
  prevFirstSeq: number;

  // Change detection
  prevHeight: number;
  prevGroupLen: number;
  prevLastSeq: number;
  prevHadFinal: boolean;
  prevStreamLen: number;
  wasIdle: boolean;

  // Reposition flags — suppress false unread badge after deliberate scroll
  idleRepositioned: boolean;
  entryRepositioned: boolean;

  // Session tracking (for inline change detection)
  prevSessionId: string | undefined;
}

function makeCtx(): ScrollCtx {
  return {
    sticky: true,
    entryPending: true,
    entryHadUnread: false,
    prepended: false,
    prevFirstSeq: 0,
    prevHeight: 0,
    prevGroupLen: 0,
    prevLastSeq: 0,
    prevHadFinal: false,
    prevStreamLen: 0,
    wasIdle: false,
    idleRepositioned: false,
    entryRepositioned: false,
    prevSessionId: undefined,
  };
}

// ── Hook ────────────────────────────────────────────────

export interface ScrollController {
  showScrollBtn: boolean;
  unreadCount: number;
  scrollToBottom: () => void;
  handleScroll: () => void;
  /** Whether older messages exist above the loaded range */
  hasOlderMessages: boolean;
}

export function useScrollController(
  scrollRef: RefObject<HTMLDivElement | null>,
  grouped: GroupedMessages[],
  streaming: string | undefined,
  sessionId: string | undefined,
  sessionIdle: boolean,
  storeUnread: number,
  firstSeq: number,
): ScrollController {
  const ctx = useRef(makeCtx());
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const hasOlderMessages = firstSeq > 1;

  // ── Session change detection (inline, before effects) ─
  // Critical: entryPending and entryHadUnread MUST be set during
  // the render phase so the layout effect can read them immediately.
  // A useEffect would run AFTER the layout effect — too late.

  const c = ctx.current;
  if (sessionId !== c.prevSessionId) {
    if (c.prevSessionId !== undefined) {
      // Session switch (not first mount) — full reset
      c.sticky = true;
      c.prepended = false;
      c.prevFirstSeq = 0;
      c.prevHeight = 0;
      c.prevGroupLen = 0;
      c.prevLastSeq = 0;
      c.prevHadFinal = false;
      c.prevStreamLen = 0;
      c.wasIdle = sessionIdle;
      c.idleRepositioned = false;
      c.entryRepositioned = false;
    }
    c.prevSessionId = sessionId;
    c.entryPending = true;
    // Only use unread entry path when messages are actually loaded AND store
    // reports unreads. Before session_list arrives, messages are empty and
    // storeUnread may be stale from localStorage — skip the unread path.
    c.entryHadUnread = storeUnread > 0 && grouped.length > 0;
  }

  // ── Prepend detection (inline, before effects) ────────
  if (firstSeq > 0 && c.prevFirstSeq > 0 && firstSeq < c.prevFirstSeq) {
    c.prepended = true;
  }
  c.prevFirstSeq = firstSeq;

  // ── Effect 1: React state reset on session switch ─────
  // Only handles state that triggers re-renders (showScrollBtn, unreadCount).
  // ctx values are already set inline above.

  useEffect(() => {
    setShowScrollBtn(false);
    setUnreadCount(0);
  }, [sessionId]);

  // ── Effect 2: Layout — ALL scrollTop writes ───────────

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const c = ctx.current;

    // ── Shared computations ─────────────────────────────

    const curLastSeq = getLastSeq(grouped);
    const curStreamLen = streaming?.length ?? 0;
    const curHasFinal = lastGroupHasFinal(grouped);
    const isFromUser = lastGroupIsFromUser(grouped);

    const contentChanged =
      grouped.length > c.prevGroupLen ||
      curLastSeq > c.prevLastSeq ||
      curStreamLen > c.prevStreamLen ||
      (curHasFinal && !c.prevHadFinal);

    const justWentIdle = sessionIdle && !c.wasIdle;

    // ── Priority chain — first match wins ───────────────

    // ① SESSION ENTRY
    if (c.entryPending) {
      if (c.entryHadUnread && scrollToTarget(el)) {
        c.sticky = false;
        c.entryRepositioned = true;
        logger.info('scroll: ① entry → target (unread)');
      } else {
        scrollToMax(el);
        c.sticky = true;
        logger.info('scroll: ① entry → bottom');
      }
      c.entryPending = false;
      c.entryHadUnread = false;
    }
    // ② PREPEND ADJUST
    else if (c.prepended) {
      if (!c.sticky && c.prevHeight > 0 && el.scrollHeight > c.prevHeight) {
        const delta = el.scrollHeight - c.prevHeight;
        el.scrollTop += delta;
        logger.info('scroll: ② prepend adjust', { delta });
      }
      c.prepended = false;
    }
    // ③ IDLE TRANSITION
    else if (justWentIdle && c.sticky && contentChanged) {
      if (scrollToTarget(el)) {
        c.sticky = false;
        c.idleRepositioned = true;
        logger.info('scroll: ③ idle → target');
      } else {
        scrollToMax(el);
        logger.info('scroll: ③ idle → bottom (fits)');
      }
    }
    // ④ AUTO-FOLLOW / USER-MESSAGE FOLLOW
    else if (contentChanged && (c.sticky || isFromUser)) {
      scrollToMax(el);
      c.sticky = true;
      logger.info('scroll: ④ follow', { sticky: c.sticky, isFromUser });
    }
    // ⑤ NO-OP

    // ── Bookkeeping ─────────────────────────────────────

    c.prevHeight = el.scrollHeight;
    c.wasIdle = sessionIdle;
  });

  // ── Effect 3: Unread counting (after paint) ───────────

  useEffect(() => {
    const c = ctx.current;

    const curLastSeq = getLastSeq(grouped);
    const curHasFinal = lastGroupHasFinal(grouped);
    const isFromUser = lastGroupIsFromUser(grouped);

    const hasBubbleAtEnd = grouped.length > 0 && (
      grouped[grouped.length - 1].type === 'standalone' || curHasFinal
    );
    const newBubbleAtEnd = hasBubbleAtEnd && (
      grouped.length > c.prevGroupLen ||
      curLastSeq > c.prevLastSeq ||
      (curHasFinal && !c.prevHadFinal)
    );

    if (c.idleRepositioned || c.entryRepositioned) {
      // Step ① or ③ just repositioned the viewport deliberately —
      // the user is reading the content, not scrolled away. Don't count as unread.
      c.idleRepositioned = false;
      c.entryRepositioned = false;
    } else if (newBubbleAtEnd && !isFromUser && !c.sticky) {
      setUnreadCount((n) => n + 1);
      setShowScrollBtn(true);
    }

    // Save prev* values here (not in Effect 2) so both effects
    // see the same "current vs previous" comparison per render.
    c.prevGroupLen = grouped.length;
    c.prevLastSeq = curLastSeq;
    c.prevHadFinal = curHasFinal;
    c.prevStreamLen = streaming?.length ?? 0;
  }, [grouped, streaming, sessionIdle]);

  // ── Effect 4: Auto gap-load when content fits viewport ─
  // When all loaded messages fit on screen and older messages exist,
  // keep loading batches until the spinner scrolls out of view
  // (scrollHeight > clientHeight) or we reach the beginning (firstSeq ≤ 1).

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !sessionId || firstSeq <= 1) return;
    if (el.scrollHeight > el.clientHeight) return;
    if (grouped.length === 0) return;
    if (messageProvider.isLoading(sessionId)) return;

    const toSeq = firstSeq - 1;
    const fromSeq = Math.max(1, toSeq - 99);
    logger.info('scroll: auto gap-load (content fits)', { sessionId, fromSeq, toSeq });
    // Re-arm entry so the next layout pass scrolls to bottom after prepend
    ctx.current.entryPending = true;
    messageProvider.fetchRange(sessionId, fromSeq, toSeq);
  }, [sessionId, firstSeq, grouped.length]);

  // ── handleScroll (user gesture) ───────────────────────

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Bottom tracking
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    ctx.current.sticky = distance < BOTTOM_STICKY_THRESHOLD_PX;
    if (ctx.current.sticky) {
      setShowScrollBtn(false);
      setUnreadCount(0);
    }

    // Gap loading: when user scrolls near the top, load older messages.
    // Guard: only when content overflows the viewport (scrollHeight > clientHeight),
    // otherwise scrollTop=0 just means everything fits — not "user is at the top".
    if (sessionId && el.scrollTop < GAP_LOAD_TOP_THRESHOLD_PX && firstSeq > 1 && el.scrollHeight > el.clientHeight) {
      if (!messageProvider.isLoading(sessionId)) {
        const toSeq = firstSeq - 1;
        const fromSeq = Math.max(1, toSeq - 99);
        logger.info('scroll: gap load (near top)', { sessionId, fromSeq, toSeq });
        messageProvider.fetchRange(sessionId, fromSeq, toSeq);
      }
    }
  }, [scrollRef, sessionId, firstSeq]);

  // ── scrollToBottom (button click) ─────────────────────

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      scrollToMax(el);
      ctx.current.sticky = true;
    }
    setShowScrollBtn(false);
    setUnreadCount(0);
  }, [scrollRef]);

  return { showScrollBtn, unreadCount, scrollToBottom, handleScroll, hasOlderMessages };
}
