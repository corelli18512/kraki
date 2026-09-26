import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronsDown } from 'lucide-react';
import type { Attachment, ContentRef } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { useOutbox, outbox } from '../../lib/chat/outbox';
import { openQuestions, payloadOf, rowKey, seqOf, spineRows } from '../../lib/chat/spine';
import { messageProvider } from '../../lib/message-provider';
import { wsClient } from '../../lib/ws-client';
import type { ChatMessage } from '../../types/store';
import { Bubble, LIVE_KEY, rowSide, type BubbleContext, type ChatRow } from './Bubble';
import { Composer, composerIntent, type ComposerHandle, type ComposerIntent } from './Composer';
import type { PermissionDecision } from './ActionSlot';
import { StepsModal } from './StepsModal';
import { ChatScroller, type ChatScrollerHandle } from './ChatScroller';
import './chat.css';

const EMPTY: ChatMessage[] = [];
/** Older pages are requested this many seqs at a time. */
const OLDER_PAGE = 60;
/** Rows rendered on entry; revealing older rows grows it by a page. */
const WINDOW_START = 60;
const WINDOW_PAGE = 40;

function lowestSeq(messages: ChatMessage[]): number {
  let low = 0;
  for (const m of messages) {
    const s = seqOf(m);
    if (Number.isInteger(s) && s > 0 && (low === 0 || s < low)) low = s;
  }
  return low;
}

function highestSeq(messages: ChatMessage[]): number {
  let high = 0;
  for (const m of messages) {
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
  const messages = useStore((s) => s.messages.get(sessionId)) ?? EMPTY;
  const session = useStore((s) => s.sessions.get(sessionId));
  const card = useStore((s) => s.cards.get(sessionId));
  const mode = useStore((s) => s.sessionModes.get(sessionId) ?? 'discuss');
  const runtime = useStore((s) => s.runtimeStatuses.get(sessionId));
  const connected = useStore((s) => s.status === 'connected');
  const deviceOnline = useStore((s) => (session ? s.devices.get(session.deviceId)?.online === true : false));
  const loading = useStore((s) => s.loadingSessions.has(sessionId));
  const allPending = useOutbox((s) => s.entries);
  const pending = useMemo(
    () => allPending.filter((e) => e.sessionId === sessionId).sort((a, b) => a.order - b.order),
    [allPending, sessionId],
  );

  // ── Rows ──
  const lastSeq = session?.lastSeq;
  const maxSeq = highestSeq(messages);
  const atHead = lastSeq === undefined || lastSeq <= 0 ? maxSeq > 0 : maxSeq >= lastSeq;
  const pendingAnswerTo = useMemo(() => pending.flatMap((e) => (e.answerTo ? [e.answerTo] : [])), [pending]);
  const answerKey = pendingAnswerTo.join(',');
  const spine = useMemo(
    () => spineRows(messages, pendingAnswerTo, atHead),
    [messages, answerKey, atHead],
  );
  const questions = useMemo(
    () => openQuestions(messages, pendingAnswerTo, atHead),
    [messages, answerKey, atHead],
  );

  const sessionActive = session?.state === 'active' || session?.state === 'compacting' || runtime?.status === 'compacting';
  const action = card?.action ?? null;
  const actionLive = action?.type === 'tool_start' || action?.type === 'tool_complete'
    || (action?.type === 'tool_batch' && action.payload.running > 0) || action?.type === 'permission';
  const permissionOpen = action?.type === 'permission' && !action.payload.decision;
  // While a turn runs, its live bubble stays from the first word or action
  // until a spine bubble concludes the segment (a reply, a question, a
  // terminal status) — not only while the card happens to have content.
  const showLive = !!card && !card.closed && (sessionActive || permissionOpen)
    && (card.text.length > 0 || actionLive || sessionActive);

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
        && cached.item.question?.state === item.question?.state ? cached : { kind: 'spine', key, item };
      nextCache.set(key, row);
      return row;
    });
    rowCache.current = nextCache;
    const landed = new Set(spine.map((i) => payloadOf(i.message).clientId).filter(Boolean));
    for (const entry of pending) {
      if (landed.has(entry.clientId)) continue;
      out.push({ kind: 'pending', key: `pending:${entry.clientId}`, entry });
    }
    if (showLive && card) out.push({ kind: 'live', key: LIVE_KEY, card });
    return out;
  }, [spine, pending, showLive, card]);

  // ── List state ──
  const listRef = useRef<ChatScrollerHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(72);
  const [upTarget, setUpTarget] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const composerBox = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(WINDOW_START);
  const visibleRows = useMemo(() => rows.slice(Math.max(0, rows.length - windowSize)), [rows, windowSize]);
  const hiddenAbove = rows.length - visibleRows.length;

  // New session: fresh index space, open at the bottom.
  useEffect(() => {
    setWindowSize(WINDOW_START);
    setUnseen(false);
    setAtBottom(true);
    atBottomRef.current = true;
  }, [sessionId]);

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

  useEffect(() => {
    const el = composerBox.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollToBottom = useCallback((smooth: boolean) => {
    listRef.current?.scrollToBottom(smooth);
    setUnseen(false);
  }, []);

  // Sending (a message, an answer, a choice) returns to the newest edge.
  const afterSubmit = useCallback(() => {
    requestAnimationFrame(() => scrollToBottom(true));
  }, [scrollToBottom]);

  // ── Older pages ──
  const lowSeq = lowestSeq(messages);
  const hasOlder = lowSeq > 1;
  const loadOlder = useCallback(() => {
    if (hiddenAbove > 0) {
      setWindowSize((n) => n + WINDOW_PAGE);
      return;
    }
    if (!hasOlder || messageProvider.isLoading(sessionId)) return;
    const toSeq = lowSeq - 1;
    setWindowSize((n) => n + WINDOW_PAGE);
    void messageProvider.fetchRange(sessionId, Math.max(1, toSeq - OLDER_PAGE + 1), toSeq);
  }, [hiddenAbove, hasOlder, lowSeq, sessionId]);

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
  const goUp = () => {
    if (upTarget) listRef.current?.scrollToRow(upTarget, true);
    else {
      loadOlder();
      const first = visibleRows[0]?.key;
      if (first) listRef.current?.scrollToRow(first, true);
    }
  };

  // ── Actions ──
  const onSend = useCallback((text: string, attachments: Attachment[] | undefined, intent: ComposerIntent) => {
    const answerTo = intent === 'answerQuestion' ? questions.at(-1)?.id : undefined;
    wsClient.sendInput(sessionId, text, { attachments, delivery: intent === 'steer' ? 'steer' : 'prompt', answerTo });
    afterSubmit();
  }, [sessionId, questions, afterSubmit]);

  const [stepsFor, setStepsFor] = useState<{ seq: number | null } | null>(null);

  const ctx = useMemo<BubbleContext>(() => ({
    sessionId,
    hueSeed: sessionId,
    sessionMode: mode,
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
    onOpenArtifact,
  }), [sessionId, mode, afterSubmit, onOpenArtifact]);

  const intent = composerIntent(sessionActive, questions.length > 0);
  const canAbort = sessionActive || showLive;
  const reachable = connected && deviceOnline;

  return (
    <div className="kchat" data-session={sessionId}>
      <ChatScroller
        key={sessionId}
        ref={listRef}
        rows={visibleRows}
        renderRow={(row: ChatRow) => <Bubble row={row} ctx={ctx} />}
        topInset={topInset + 8}
        bottomInset={composerHeight + 8}
        header={(hiddenAbove > 0 || hasOlder) ? <div className="ktop-loader"><span className="kspinner" /></div> : null}
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
        onNearTop={loadOlder}
        onScroll={measureUp}
      />
      {rows.length === 0 && (
        <div className="kchat-empty" style={{ paddingTop: topInset }}>
          {loading ? <span className="kspinner" /> : <p>Send a message to start.</p>}
        </div>
      )}

      <div className="kjump" style={{ bottom: composerHeight + 8 }}>
        <button
          type="button"
          className={`kround ${showUp ? 'is-visible' : ''} ${atBottom ? '' : 'is-raised'}`}
          aria-label="Previous reply"
          tabIndex={showUp ? 0 : -1}
          onClick={goUp}
        ><ChevronUp aria-hidden /></button>
        <button
          type="button"
          className={`kround ${!atBottom && rows.length > 0 ? 'is-visible' : ''}`}
          aria-label="Jump to latest"
          tabIndex={!atBottom ? 0 : -1}
          onClick={() => scrollToBottom(true)}
        >
          <ChevronsDown aria-hidden />
          {unseen && <span className="kround-dot" aria-label="New reply" />}
        </button>
      </div>

      <div className="kcomposer-dock" ref={composerBox}>
        <Composer
          ref={composerRef}
          sessionId={sessionId}
          intent={intent}
          canAbort={canAbort}
          reachable={reachable}
          onSend={onSend}
          onAbort={() => wsClient.abortSession(sessionId)}
        />
      </div>

      {stepsFor && (
        <StepsModal sessionId={sessionId} bubbleSeq={stepsFor.seq} onClose={() => setStepsFor(null)} />
      )}
    </div>
  );
});
