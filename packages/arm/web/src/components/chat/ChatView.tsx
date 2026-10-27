import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { ChevronUp, ChevronsDown, Loader } from 'lucide-react';
import type { Attachment, ContentRef } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { diag } from '../../lib/diag';
import { useNarrow } from '../../hooks/useNarrow';
import { agentNavigationColors } from '../../lib/color';
import { useOutbox, outbox } from '../../lib/chat/outbox';
import { openQuestions, payloadOf, rowKey, seqOf, spineRows } from '../../lib/chat/spine';
import { isSpineMessage, messageProvider } from '../../lib/message-provider';
import { wsClient } from '../../lib/ws-client';
import type { ChatMessage } from '../../types/store';
import { Bubble, LIVE_KEY, rowSide, type BubbleContext, type ChatRow } from './Bubble';
import { Composer, composerIntent, type ComposerHandle, type ComposerIntent } from './Composer';
import type { PermissionDecision } from './ActionSlot';
import { StepsModal } from './StepsModal';
import { ChatScroller, type ChatScrollerHandle } from './ChatScroller';
import { HistoryLoadStatus } from './HistoryLoadStatus';
import { captureEntryBoundary, firstUnreadKey, hasUnreadGap } from '../../lib/chat/unread-entry';
import './chat.css';

const EMPTY: ChatMessage[] = [];
/** Older pages are requested this many seqs at a time. */
const OLDER_PAGE = 60;
/** Rows rendered on entry; revealing older rows grows it by a page. */
const WINDOW_START = 60;
const WINDOW_PAGE = 40;

/** Lowest conversation (spine) seq held; the older-paging cursor. Runtime
 *  signals carry the relay's broadcast seq (see `highestSeq`). */
export function lowestSeq(messages: ChatMessage[]): number {
  let low = 0;
  for (const m of messages) {
    if (!isSpineMessage(m)) continue;
    const s = seqOf(m);
    if (Number.isInteger(s) && s > 0 && (low === 0 || s < low)) low = s;
  }
  return low;
}

/** Highest conversation (spine) seq held. Runtime signals such as `active`
 *  carry the relay's broadcast seq, a different counter: counting them could
 *  declare the window at the head while spine rows are still missing (and so
 *  present a stale question as open). */
export function highestSeq(messages: ChatMessage[]): number {
  let high = 0;
  for (const m of messages) {
    if (!isSpineMessage(m)) continue;
    const s = seqOf(m);
    if (Number.isInteger(s) && s > high) high = s;
  }
  return high;
}

export interface ChatViewProps {
  sessionId: string;
  /** Space the floating header occupies over the list. */
  topInset: number;
  onOpenArtifact?: (artifact: ContentRef) => void;
}

export const ChatView = memo(function ChatView({ sessionId, topInset, onOpenArtifact }: ChatViewProps) {
  const { t, i18n } = useTranslation('chat');
  const messages = useStore((s) => s.messages.get(sessionId)) ?? EMPTY;
  const session = useStore((s) => s.sessions.get(sessionId));
  const rawCard = useStore((s) => s.cards.get(sessionId));
  const cardHoldUntil = useStore((s) => s.cardHoldUntil.get(sessionId)) ?? 0;
  const historyCaughtUpThrough = useStore((s) => s.historyCaughtUpThrough.get(sessionId)) ?? 0;
  const runtime = useStore((s) => s.runtimeStatuses.get(sessionId));
  const connected = useStore((s) => s.status === 'connected');
  const deviceOnline = useStore((s) => (session ? s.devices.get(session.deviceId)?.online === true : false));
  const getRangeStatus = useCallback(() => messageProvider.getRangeStatus(sessionId), [sessionId]);
  const rangeStatus = useSyncExternalStore(messageProvider.subscribeRangeStatus, getRangeStatus, getRangeStatus);
  const loading = !!session && rangeStatus.state === 'loading';
  const showHistoryStatus = !!session && (loading || rangeStatus.state === 'error' || rangeStatus.state === 'incomplete');
  const retryHistory = useCallback(() => {
    // Check again at admission: stale events and repeated clicks cannot start work.
    if (!useStore.getState().sessions.has(sessionId) || messageProvider.isLoading(sessionId)) return;
    const status = messageProvider.getRangeStatus(sessionId);
    if (status.state === 'error' || status.state === 'incomplete') messageProvider.retryRange(sessionId);
  }, [sessionId]);
  const allPending = useOutbox((s) => s.entries);
  const pending = useMemo(
    () => allPending.filter((e) => e.sessionId === sessionId).sort((a, b) => a.order - b.order),
    [allPending, sessionId],
  );

  // ── Rows ──
  const lastSeq = session?.lastSeq;
  const maxSeq = highestSeq(messages);
  // Live deltas keep updating a subscription card while its preceding spine
  // catches up. Do not draw it beneath an older cached conversation tail.
  const cardCaughtUp = historyCaughtUpThrough >= cardHoldUntil
    || messages.some((m) => isSpineMessage(m) && seqOf(m) >= cardHoldUntil);
  const card = cardCaughtUp ? rawCard : undefined;
  // Performance data (open.summary / ready.summary): what is on screen now.
  useEffect(() => {
    if (diag.stability.wantsConversationUpdates) diag.stability.conversationRendered(sessionId, maxSeq, lastSeq ?? 0, messages.length > 0);
  }, [sessionId, maxSeq, lastSeq, messages.length]);
  const atHead = lastSeq === undefined || lastSeq <= 0 ? maxSeq > 0 : maxSeq >= lastSeq;
  // A locally failed answer never reached the agent: its question stays open
  // and answerable (Mac ChatViewModel excludes failed answers too).
  const pendingAnswerTo = useMemo(() => pending.flatMap((e) => (e.answerTo && e.state !== 'failed' ? [e.answerTo] : [])), [pending]);
  const answerKey = pendingAnswerTo.join(',');
  const spine = useMemo(
    () => spineRows(messages, pendingAnswerTo, atHead),
    [messages, answerKey, atHead, i18n.language],
  );
  const questions = useMemo(
    () => openQuestions(messages, pendingAnswerTo, atHead),
    [messages, answerKey, atHead, i18n.language],
  );

  const isCompacting = session?.state === 'compacting' || runtime?.status === 'compacting';
  const sessionActive = session?.state === 'active' || isCompacting;
  const action = card?.action ?? null;
  const actionLive = action?.type === 'tool_start' || action?.type === 'tool_complete'
    || (action?.type === 'tool_batch' && action.payload.running > 0) || action?.type === 'permission';
  const permissionOpen = action?.type === 'permission' && !action.payload.decision;
  // While a turn runs, its live bubble stays from the first word or action
  // until a spine bubble concludes the segment (a reply, a question, a
  // terminal status) — not only while the card happens to have content.
  // A pending question waits for the human, not another empty typing row.
  // While that question is the newest row, tools the agent runs in parallel
  // with it stay in Steps rather than becoming a second bubble under it;
  // genuine draft text or a permission still gets its own live row.
  const questionNewest = spine.at(-1)?.question?.state === 'open';
  const hasText = !!card && card.text.trim().length > 0;
  const showLive = !!card && !card.closed && (sessionActive || permissionOpen)
    && (hasText || (actionLive && (!questionNewest || action?.type === 'permission'))
      || (session?.state === 'active' && questions.length === 0));

  // Row objects are reused while their record is unchanged, so memoized
  // bubbles only re-render when their own content changes.
  const rowCache = useRef(new Map<string, ChatRow>());
  const rows = useMemo<ChatRow[]>(() => {
    const cache = rowCache.current;
    const nextCache = new Map<string, ChatRow>();
    const out: ChatRow[] = spine.map((item) => {
      const key = rowKey(item);
      const cached = cache.get(key);
      const row: ChatRow = cached && cached.kind === 'spine' && cached.item.message === item.message
        && cached.item.question?.state === item.question?.state
        && cached.item.question?.outcome?.message === item.question?.outcome?.message ? cached : { kind: 'spine', key, item };
      nextCache.set(key, row);
      return row;
    });
    rowCache.current = nextCache;
    const landed = new Set(spine.map((i) => payloadOf(i.message).clientId).filter(Boolean));
    // Failed inputs stay where they were written, but only within the loaded
    // spine window (Mac ChatViewModel.place). Retrying puts them at the tail.
    const windowStart = spine.find((item) => seqOf(item.message) > 0);
    const startSeq = windowStart ? seqOf(windowStart.message) : Infinity;
    const remaining = pending.filter((entry) => !landed.has(entry.clientId));
    const anchored = remaining.filter((entry) => entry.state === 'failed'
      && entry.afterSeq !== undefined && entry.afterSeq >= startSeq)
      .sort((a, b) => a.afterSeq! - b.afterSeq! || a.order - b.order);
    for (const entry of anchored) {
      const index = out.findIndex((row) => row.kind === 'spine' && seqOf(row.item.message) > entry.afterSeq!);
      out.splice(index < 0 ? out.length : index, 0, { kind: 'pending', key: `pending:${entry.clientId}`, entry });
    }
    const anchoredIds = new Set(anchored.map((entry) => entry.clientId));
    for (const entry of remaining) {
      if (!anchoredIds.has(entry.clientId)) out.push({ kind: 'pending', key: `pending:${entry.clientId}`, entry });
    }
    if (showLive && card) {
      const anchor = card.steer?.anchor;
      const index = anchor ? out.findIndex((row) => row.kind === 'pending' ? row.entry.clientId === anchor
        : row.kind === 'spine' && row.item.message.type === 'user_message'
          && (payloadOf(row.item.message).clientId === anchor || `${sessionId}:${seqOf(row.item.message)}` === anchor)) : -1;
      out.splice(index < 0 ? out.length : index, 0, { kind: 'live', key: LIVE_KEY, card });
    }
    return out;
  }, [spine, pending, showLive, card, sessionId]);

  // ── List state ──
  const listRef = useRef<ChatScrollerHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(72);
  const measuredComposerHeight = useRef(72);
  const narrow = useNarrow();
  // Mac's floating composer grows over chat, without moving the newest edge.
  // ChatBottomObstruction: 36 capsule + 2×12 bottom padding − 6 row margin.
  const bottomClearance = narrow ? composerHeight + 8 : 54;
  // Desktop: the dock's growth above its resting height (multiline draft,
  // dictation, compaction status) covers the tail; give the list that much
  // extra reach so it can be scrolled into view (Mac composerOverlayInset).
  const restingDock = useRef<number | null>(null);
  const overlayReach = narrow || restingDock.current === null ? 0 : Math.max(0, Math.round(composerHeight - restingDock.current));
  const historyBox = useRef<HTMLDivElement>(null);
  const [historyHeight, setHistoryHeight] = useState(0);
  const measuredHistoryHeight = useRef(0);
  // Measurements reserve transcript space only. The status itself is positioned
  // by its dock containing block, so child-only draft growth cannot overlap it
  // while ResizeObserver delivery or the resulting React commit is pending.
  const statusClearance = Math.max(bottomClearance, composerHeight + historyHeight + 8);
  useLayoutEffect(() => {
    const box = historyBox.current;
    if (!box) return;
    const measure = (synchronous: boolean) => {
      const height = box.getBoundingClientRect().height;
      if (height === measuredHistoryHeight.current) return;
      measuredHistoryHeight.current = height;
      if (synchronous) flushSync(() => setHistoryHeight(height));
      else setHistoryHeight(height);
    };
    measure(false);
    const observer = new ResizeObserver(() => measure(true));
    observer.observe(box);
    return () => observer.disconnect();
  }, [showHistoryStatus, sessionId]);
  const [upTarget, setUpTarget] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const composerBox = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(WINDOW_START);
  const retainedStart = useRef<string | null>(null);
  const navigation = useRef({ generation: 0, active: false });
  const cancelNavigation = useCallback(() => {
    navigation.current.generation++;
    navigation.current.active = false;
  }, []);

  // Entered with new messages: the read position, captured on this entry's
  // first render — before SessionPage's effect marks the Session read.
  const entry = useRef<{ sessionId: string; boundary: number | null; hadGap: boolean } | null>(null);
  if (entry.current?.sessionId !== sessionId) {
    entry.current = { sessionId, hadGap: hasUnreadGap(sessionId), boundary: captureEntryBoundary(sessionId) };
  }
  const [unreadEntryLive, setUnreadEntryLive] = useState(true);
  useEffect(() => { setUnreadEntryLive(true); }, [sessionId]);
  const entryBoundary = unreadEntryLive ? entry.current.boundary : null;
  // Like iPhone (atNewest) and Mac (!hasUnloadedNewer): only once the rows
  // reach the head, or a stale cached tail would land on an old reply.
  const entryHadGap = entry.current.hadGap && atHead;
  const unreadTarget = useMemo(() => (entryBoundary === null ? null : firstUnreadKey(
    rows.map((r) => r.kind === 'spine'
      ? { key: r.key, seq: seqOf(r.item.message) || undefined, isUser: r.item.message.type === 'user_message' }
      : { key: r.key }),
    entryBoundary,
    entryHadGap,
  )), [rows, entryBoundary, entryHadGap]);

  // Keep the loaded first-unread row and the reading window mounted. Tail
  // arrivals may grow this window; only returning to the tail may trim it.
  let windowStart = Math.max(0, rows.length - windowSize);
  if (!atBottomRef.current && retainedStart.current) {
    const retained = rows.findIndex((row) => row.key === retainedStart.current);
    if (retained >= 0) windowStart = Math.min(windowStart, retained);
  }
  if (unreadTarget) {
    const unreadIndex = rows.findIndex((row) => row.key === unreadTarget);
    if (unreadIndex >= 0) windowStart = Math.min(windowStart, unreadIndex);
  }
  const visibleRows = useMemo(() => rows.slice(windowStart), [rows, windowStart]);
  retainedStart.current = visibleRows[0]?.key ?? null;
  const hiddenAbove = windowStart;

  // New session: fresh index space. Where it opens (the newest edge, or the
  // first new message) is reported by its own scroller, which is recreated
  // per Session and reports during layout — before this effect would run,
  // so resetting "at bottom" here would overwrite a first-new-message landing.
  useEffect(() => {
    setWindowSize(WINDOW_START);
    setUnseen(false);
    return cancelNavigation;
  }, [sessionId, cancelNavigation]);

  // A reply that lands while the reader is away marks ↓ with a dot.
  const lastAgentKey = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === 'spine' && rowSide(rows[i]) === 'agent') return rows[i].key;
    }
    return undefined;
  }, [rows]);
  const seenAgentKey = useRef(lastAgentKey);
  useEffect(() => {
    if (lastAgentKey && lastAgentKey !== seenAgentKey.current && !atBottomRef.current) setUnseen(true);
    seenAgentKey.current = lastAgentKey;
  }, [lastAgentKey]);

  const measureComposer = useCallback((synchronous: boolean) => {
    const height = composerBox.current?.getBoundingClientRect().height;
    // An unlaid-out/hidden dock has no usable clearance; retain its last size.
    if (!height) return;
    // Preserve desktop overlay reach when no history strip is present.
    if (restingDock.current === null || height < restingDock.current) restingDock.current = height;
    if (height === measuredComposerHeight.current) return;
    // Set the guard before publishing: the resulting commit/observer delivery
    // must not feed the same measurement back into another synchronous commit.
    measuredComposerHeight.current = height;
    if (synchronous) flushSync(() => setComposerHeight(height));
    else setComposerHeight(height);
  }, []);
  // Parent commits (including compaction/session changes) settle before paint.
  // Do not flushSync from a React lifecycle.
  useLayoutEffect(() => { measureComposer(false); });
  useLayoutEffect(() => {
    const el = composerBox.current;
    if (!el) return;
    // Composer owns its draft and can commit without rendering ChatView. Observe
    // only dock mutations outside the out-of-flow history subtree; transcript
    // padding is outside this subtree too, so reserving space cannot feed back.
    const mutations = new MutationObserver((records) => {
      if (records.some(record => !historyBox.current?.contains(record.target))) measureComposer(true);
    });
    mutations.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    // Intrinsic/font/viewport changes need no DOM mutation. Commit their measured
    // clearance in this before-paint callback, not a later React render.
    const resize = new ResizeObserver(() => measureComposer(true));
    resize.observe(el);
    return () => { mutations.disconnect(); resize.disconnect(); };
  }, [measureComposer]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    cancelNavigation();
    listRef.current?.scrollToBottom(smooth);
    setUnseen(false);
  }, [cancelNavigation]);

  // Sending (a message, an answer, a choice) returns to the newest edge.
  const afterSubmit = useCallback(() => {
    requestAnimationFrame(() => scrollToBottom(true));
  }, [scrollToBottom]);

  // New bubbles enter from their side; older pages and the live → landed
  // handoff do not (ChatScroller.newTailKeys).
  const entranceSide = useCallback((row: ChatRow) => {
    const side = rowSide(row);
    return side === 'user' ? 'right' : side === 'agent' ? 'left' : null;
  }, []);

  // ── Older pages ──
  const lowSeq = lowestSeq(messages);
  // A successful empty/sparse range still advances history. Do not derive
  // the next request solely from rows: a whole page may have no visible row.
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const olderBefore = olderCursor === null ? lowSeq : Math.min(lowSeq, olderCursor);
  const hasOlder = olderBefore > 1;
  const olderInFlight = useRef(false);
  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (hiddenAbove > 0) {
      flushSync(() => setWindowSize(rows.length - hiddenAbove + WINDOW_PAGE));
      return true;
    }
    if (!hasOlder || olderInFlight.current || messageProvider.isLoading(sessionId)
      || rangeStatus.state === 'incomplete') return false;
    const toSeq = olderBefore - 1;
    const fromSeq = Math.max(1, toSeq - OLDER_PAGE + 1);
    olderInFlight.current = true;
    try {
      const completed = await messageProvider.fetchRange(sessionId, fromSeq, toSeq);
      if (!completed) return false;
      // Commit the page window AND loader removal before ↑ measures a row.
      // Store delivery can have rendered first, before this await resumed.
      flushSync(() => {
        setOlderCursor(fromSeq);
        setWindowSize((n) => n + OLDER_PAGE);
      });
      return true;
    } finally {
      olderInFlight.current = false;
    }
  }, [hiddenAbove, hasOlder, olderBefore, rows.length, sessionId, rangeStatus]);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  // ── ↑: the start of the nearest reply whose top is above the view ──
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const measureUp = useCallback(() => {
    const above = listRef.current?.rowsAbove() ?? [];
    const byKey = new Map(rowsRef.current.map((r) => [r.key, r]));
    let target: string | null = null;
    for (const key of above) {
      const row = byKey.get(key);
      if (row && rowSide(row) === 'agent') target = key;
    }
    setUpTarget(target);
  }, []);
  useEffect(() => { measureUp(); }, [visibleRows, measureUp]);

  const showUp = rows.length > 0 && (upTarget !== null || hiddenAbove > 0 || hasOlder);
  const goUp = async () => {
    if (navigation.current.active) return;
    const generation = ++navigation.current.generation;
    navigation.current.active = true;
    let pageCompleted: boolean | undefined = true;
    // Like Mac's navigation load: keep looking across pages without replies,
    // but bound a single click and cancel it on manual input, ↓ or unmount.
    for (let pages = 0; pages <= 8; pages++) {
      const waitingSince = performance.now();
      while (true) {
        if (navigation.current.generation !== generation) return;
        // Loaded replies win immediately, including incremental cache/page
        // delivery during this click's own fetch, before range completion.
        const above = new Set(listRef.current?.rowsAbove() ?? []);
        const target = [...rowsRef.current].reverse().find((row) => above.has(row.key) && rowSide(row) === 'agent');
        if (target) {
          navigation.current.active = false;
          listRef.current?.scrollToRow(target.key, true);
          return;
        }
        if (!messageProvider.isLoading(sessionId) && pageCompleted !== undefined) break;
        if (performance.now() - waitingSince >= 3000) {
          navigation.current.active = false;
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (pages === 8 || !pageCompleted) break;
      pageCompleted = undefined;
      // Keep polling targets/cancellation while loadOlder independently waits
      // for full coverage before advancing its cursor and growing the window.
      void loadOlderRef.current().then((completed) => { pageCompleted = completed; });
      // Store delivery and window expansion must commit before measuring the
      // newly prepended replies (including a page that only changed the cursor).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (navigation.current.generation === generation) navigation.current.active = false;
  };

  // ── Actions ──
  const onSend = useCallback((text: string, attachments: Attachment[] | undefined, intent: ComposerIntent) => {
    if (intent === 'denyPermission' && action?.type === 'permission') {
      // Typing while a permission waits: the text is the reason for denying it.
      // If it never reaches the agent the permission comes back; so does the
      // reason, unless something new was typed meanwhile (Mac keeps it too).
      wsClient.resolvePermission(sessionId, String(action.payload.id), action.payload.toolName as string | undefined, 'deny', text, () => {
        const store = useStore.getState();
        if (!(store.drafts.get(sessionId) ?? '').trim()) store.setDraft(sessionId, text);
      });
      return;
    }
    const answerTo = intent === 'answerQuestion' ? questions.at(-1)?.id : undefined;
    wsClient.sendInput(sessionId, text, { attachments, delivery: intent === 'steer' ? 'steer' : 'prompt', answerTo });
    afterSubmit();
  }, [sessionId, questions, afterSubmit, action]);

  const [stepsFor, setStepsFor] = useState<{ seq: number | null } | null>(null);

  const ctx = useMemo<BubbleContext>(() => ({
    sessionId,
    hueSeed: sessionId,
    onAnswer: (questionId, choice) => {
      wsClient.sendInput(sessionId, choice, { answerTo: questionId });
      afterSubmit();
    },
    onPermission: (permissionId, toolName, decision: PermissionDecision) => {
      wsClient.resolvePermission(sessionId, permissionId, toolName, decision);
    },
    onOpenSteps: (seq) => setStepsFor({ seq }),
    onRetry: (clientId) => outbox.retry(clientId),
    onDelete: (clientId) => { outbox.discard(clientId); },
    onEditPending: (clientId) => {
      const entry = outbox.forSession(sessionId).find((e) => e.clientId === clientId && e.state === 'correcting');
      if (entry && composerRef.current?.editStaged(entry)) outbox.discard(clientId);
    },
    onOpenArtifact,
  }), [sessionId, afterSubmit, onOpenArtifact]);

  const intent = composerIntent(sessionActive, questions.length > 0, permissionOpen);
  const canAbort = sessionActive || showLive;
  const reachable = connected && deviceOnline;
  const navigationColors = agentNavigationColors(sessionId);

  return (
    <div className="kchat" data-session={sessionId}>
      <ChatScroller
        key={sessionId}
        ref={listRef}
        rows={visibleRows}
        renderRow={(row: ChatRow) => <Bubble row={row} ctx={ctx} />}
        topInset={topInset + 8}
        bottomInset={showHistoryStatus ? statusClearance : bottomClearance}
        overlayReach={showHistoryStatus ? 0 : overlayReach}
        header={(hiddenAbove > 0 || hasOlder) ? <div className="ktop-loader">{loading && <span className="kspinner" />}</div> : null}
        onAtBottomChange={(bottom) => {
          atBottomRef.current = bottom;
          setAtBottom(bottom);
          if (bottom) {
            setUnseen(false);
            // Back at the newest edge: let the rendered window shrink again
            // (history stays in memory; it is revealed again on the way up).
            setTimeout(() => { if (atBottomRef.current) setWindowSize(WINDOW_START); }, 600);
          }
        }}
        onNearTop={() => { void loadOlder(); }}
        onUserInteraction={cancelNavigation}
        onScroll={measureUp}
        unreadTarget={entry.current.boundary === null ? undefined : unreadTarget}
        onUnreadEntryEnd={() => setUnreadEntryLive(false)}
        entranceSide={entranceSide}
      />
      {session && rows.length === 0 && !showHistoryStatus && (
        <div className="kchat-empty" style={{ paddingTop: topInset }}>
          <p>{t('view.empty')}</p>
        </div>
      )}
      <div className="kjump" style={{
        // MacComposerMetrics: bottomPadding12 + control36 + stackGap9.
        bottom: narrow ? composerHeight + 8 : 57,
        '--k-jump-light': navigationColors.light,
        '--k-jump-dark': navigationColors.dark,
      } as CSSProperties}>
        <button
          type="button"
          className={`kround ${showUp ? 'is-visible' : ''} ${atBottom ? '' : 'is-raised'}`}
          aria-label={t('view.previousReply')}
          tabIndex={showUp ? 0 : -1}
          onClick={goUp}
        ><ChevronUp aria-hidden /></button>
        <button
          type="button"
          className={`kround is-latest ${!atBottom && rows.length > 0 ? 'is-visible' : ''}`}
          aria-label={t('view.latest')}
          tabIndex={!atBottom ? 0 : -1}
          onClick={() => scrollToBottom(true)}
        >
          <ChevronsDown aria-hidden />
          {unseen && <span className="kround-dot" aria-label={t('view.newReply')} />}
        </button>
      </div>

      <div className="kcomposer-dock" ref={composerBox}>
        <div ref={historyBox} className="khistory-position">
          {showHistoryStatus && <HistoryLoadStatus status={rangeStatus} onRetry={retryHistory} />}
        </div>
        {isCompacting && (
          <div className="kcompacting" role="status" aria-label={t('view.compactingLabel')}>
            <Loader className="kcompacting-spinner" aria-hidden />
            <span>{t('view.compacting')}</span>
          </div>
        )}
        <Composer
          ref={composerRef}
          sessionId={sessionId}
          intent={intent}
          canAbort={canAbort}
          reachable={reachable}
          busy={sessionActive}
          agent={session?.agent}
          onSend={onSend}
          onStageVoice={(text, attachments, voiceIntent) => {
            const id = outbox.stage(sessionId, text, {
              attachments, delivery: voiceIntent === 'steer' ? 'steer' : 'prompt',
              answerTo: voiceIntent === 'answerQuestion' ? questions.at(-1)?.id : undefined,
            });
            afterSubmit();
            return id;
          }}
          onAbort={(onRefused) => wsClient.abortSession(sessionId, onRefused)}
        />
      </div>

      {stepsFor && (
        <StepsModal sessionId={sessionId} bubbleSeq={stepsFor.seq} onClose={() => setStepsFor(null)} />
      )}
    </div>
  );
});
