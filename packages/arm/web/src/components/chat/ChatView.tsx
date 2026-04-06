import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, type MutableRefObject } from 'react';
import { useParams } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { MessageBubble } from './MessageBubble';
import { ThinkingBox } from './ThinkingBox';
import { MessageInput } from './MessageInput';
import { PermissionInput } from '../actions/PermissionInput';
import { QuestionInput } from '../actions/QuestionInput';
import { useTurns } from '../../hooks/useTurns';
import { GapMarker } from './GapMarker';
import { createLogger } from '../../lib/logger';
import type { ChatMessage } from '../../types/store';
import type { Attachment } from '@kraki/protocol';

const logger = createLogger('chat-view');

const EMPTY_MESSAGES: ChatMessage[] = [];

/** Collect image attachments from tool_complete messages in a turn's thinking. */
function collectTurnImages(thinkingMessages: ChatMessage[]): Attachment[] {
  const images: Attachment[] = [];
  for (const m of thinkingMessages) {
    if (m.type === 'tool_complete' && Array.isArray(m.payload?.attachments)) {
      for (const att of m.payload.attachments) {
        if (att.type === 'image') images.push(att as Attachment);
      }
    }
  }
  return images;
}

/** Extract seq from a message, returning 0 for non-sequenced messages. */
function getSeq(m: ChatMessage): number {
  return 'seq' in m ? (m as { seq?: number }).seq ?? 0 : 0;
}

/**
 * Detect gaps in a sorted message array.
 * Returns beforeSeq values — the seq of the first message after each gap.
 * For the implicit top gap, beforeSeq is the first message's seq.
 */
function detectGaps(messages: ChatMessage[]): number[] {
  const gaps: number[] = [];
  const seqs = messages.map(getSeq).filter(s => s > 0);
  if (seqs.length === 0) return gaps;

  // Implicit gap at top: messages don't start at seq 1
  if (seqs[0] > 1) {
    gaps.push(seqs[0]);
  }

  // Interior gaps: beforeSeq is the seq after the gap
  for (let i = 0; i < seqs.length - 1; i++) {
    if (seqs[i + 1] - seqs[i] > 1) {
      gaps.push(seqs[i + 1]);
    }
  }
  return gaps;
}

export function ChatView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const messagesMap = useStore((s) => s.messages);
  const streamingMap = useStore((s) => s.streamingContent);
  const session = useStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const devices = useStore((s) => s.devices);
  const isDeviceOnline = session ? devices.get(session.deviceId)?.online ?? false : false;
  const permissionsMap = useStore((s) => s.pendingPermissions);
  const questionsMap = useStore((s) => s.pendingQuestions);

  const messages = sessionId ? messagesMap.get(sessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
  const streaming = sessionId ? streamingMap.get(sessionId) : undefined;

  const pendingPermIds = useMemo(
    () => new Set([...permissionsMap.values()].map((p) => p.id)),
    [permissionsMap],
  );

  const permissions = useMemo(
    () => [...permissionsMap.values()].filter((p) => p.sessionId === sessionId),
    [permissionsMap, sessionId],
  );
  const questions = useMemo(
    () => [...questionsMap.values()].filter((q) => q.sessionId === sessionId),
    [questionsMap, sessionId],
  );

  // Filter out pending permission bubbles — the blocking card handles them.
  // Questions are always shown as normal chat bubbles.
  const filteredMessages = useMemo(
    () => messages.filter((msg) => {
      if (msg.type === 'permission' && pendingPermIds.has(msg.payload.id)) return false;
      return true;
    }),
    [messages, pendingPermIds],
  );

  // Detect gaps in the message sequence
  const gaps = useMemo(() => sessionId ? detectGaps(filteredMessages) : [], [filteredMessages, sessionId]);

  // Show spinner at top if there are older messages not yet loaded
  const firstSeq = useMemo(() => {
    const seqs = filteredMessages.map(getSeq).filter(s => s > 0);
    return seqs.length > 0 ? seqs[0] : 0;
  }, [filteredMessages]);
  const hasOlderMessages = firstSeq > 1;

  const rawGrouped = useTurns(filteredMessages);

  // Only the last turn can be active, and only if the session isn't idle
  const sessionIdle = filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1].type === 'idle';

  // Log turn grouping for debugging
  useMemo(() => {
    if (!sessionId) return;
    const turns = rawGrouped.filter(g => g.type === 'turn');
    const activeTurns = turns.filter(g => g.type === 'turn' && !g.turn.finalMessage);
    if (activeTurns.length > 0 || turns.length > 0) {
      logger.info('turns grouped', {
        sessionId,
        totalGroups: rawGrouped.length,
        turnCount: turns.length,
        activeTurns: activeTurns.length,
        messageCount: filteredMessages.length,
        turnDetails: turns.map((g, i) => ({
          idx: i,
          thinkingCount: g.turn.thinkingMessages.length,
          hasFinal: !!g.turn.finalMessage,
          finalType: g.turn.finalMessage?.type ?? 'null',
          lastThinkingType: g.turn.thinkingMessages.length > 0 ? g.turn.thinkingMessages[g.turn.thinkingMessages.length - 1].type : 'none',
          lastThinkingSeq: g.turn.thinkingMessages.length > 0 ? ('seq' in g.turn.thinkingMessages[g.turn.thinkingMessages.length - 1] ? (g.turn.thinkingMessages[g.turn.thinkingMessages.length - 1] as { seq?: number }).seq : '?') : '?',
        })),
      });
    }
  }, [rawGrouped, sessionId, filteredMessages.length]);

  // Ensure streaming always attaches to a turn group
  const grouped = useMemo(() => {
    if (!streaming) return rawGrouped;
    const last = rawGrouped[rawGrouped.length - 1];
    if (last && last.type === 'turn' && !last.turn.finalMessage) return rawGrouped;
    // No in-progress turn — append one so streaming has a home
    return [...rawGrouped, { type: 'turn' as const, turn: { thinkingMessages: [] as ChatMessage[], finalMessage: null } }];
  }, [rawGrouped, streaming]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const prevMsgLenRef: MutableRefObject<number> = useRef(0);
  const prevLastSeqRef = useRef(0);
  const prevScrollHeightRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    setShowScrollBtn(false);
    setUnreadCount(0);
  }, []);

  // Preserve scroll position when older messages are prepended (before paint)
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const prevHeight = prevScrollHeightRef.current;
    if (prevHeight > 0 && el.scrollHeight > prevHeight && !isAtBottomRef.current) {
      el.scrollTop += el.scrollHeight - prevHeight;
    }
    prevScrollHeightRef.current = el.scrollHeight;
  });

  // Auto-scroll to bottom when new messages arrive (only if already at bottom)
  useEffect(() => {
    // Detect if messages were appended (new) vs prepended (history)
    const curLen = grouped.length;
    let curLastSeq = 0;
    if (curLen > 0) {
      const lastGroup = grouped[curLen - 1];
      if (lastGroup.type === 'standalone') {
        curLastSeq = getSeq(lastGroup.message);
      } else {
        const tm = lastGroup.turn.finalMessage ?? lastGroup.turn.thinkingMessages[lastGroup.turn.thinkingMessages.length - 1];
        if (tm) curLastSeq = getSeq(tm);
      }
    }
    const isNewAtEnd = curLastSeq > prevLastSeqRef.current;

    if (isAtBottomRef.current) {
      scrollToBottom();
    } else if (isNewAtEnd) {
      // Only count as unread if new messages were appended at the end
      const prevLen = prevMsgLenRef.current;
      if (curLen > prevLen) {
        const lastGroup = grouped[curLen - 1];
        const isFromUser = lastGroup?.type === 'standalone' && (
          lastGroup.message.type === 'user_message' ||
          lastGroup.message.type === 'pending_input' ||
          lastGroup.message.type === 'answer' ||
          lastGroup.message.type === 'send_input'
        );
        if (!isFromUser) {
          setUnreadCount((c) => c + (curLen - prevLen));
          setShowScrollBtn(true);
        }
      } else if (streaming) {
        setShowScrollBtn(true);
      }
    }
    prevMsgLenRef.current = curLen;
    prevLastSeqRef.current = curLastSeq;
  }, [grouped, streaming, scrollToBottom]);

  // Reset when switching sessions
  useEffect(() => {
    setShowScrollBtn(false);
    setUnreadCount(0);
    isAtBottomRef.current = true;
    // Scroll to bottom on session change
    setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, 0);
  }, [sessionId]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      setShowScrollBtn(false);
      setUnreadCount(0);
    }
  };

  // Build a set of beforeSeq values for inserting gap markers
  const gapSet = useMemo(() => new Set(gaps), [gaps]);

  if (!sessionId || !session) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <img src="/logo.png" alt="Kraki" className="mx-auto h-40 w-40 object-contain animate-logo-reveal" />
          <p className="mt-4 text-sm text-text-muted animate-fade-up">Select a session to view</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto px-3 py-4 sm:px-6"
        >
          <div className="mx-auto max-w-3xl space-y-3">
            {/* Top spinner when older messages exist */}
            {hasOlderMessages && (
              <GapMarker sessionId={sessionId!} beforeSeq={firstSeq} scrollRef={scrollRef} />
            )}
            {grouped.map((item, idx) => {
              if (item.type === 'standalone') {
                const msg = item.message;
                const seq = getSeq(msg);
                return (
                  <div key={`g-${idx}`}>
                    {/* Interior gap marker */}
                    {sessionId && seq > 0 && gapSet.has(seq) && seq !== firstSeq && (
                      <div className="mb-3">
                        <GapMarker sessionId={sessionId} beforeSeq={seq} scrollRef={scrollRef} />
                      </div>
                    )}
                    <MessageBubble
                      message={msg}
                      agent={session.agent}
                    />
                  </div>
                );
              }

              const { turn } = item;
              const isLastTurn = idx === grouped.length - 1;
              const hasStreaming = isLastTurn && !!streaming;
              const isActive = isLastTurn && !sessionIdle && (!turn.finalMessage || hasStreaming);

              // Get the first seq in this turn for gap detection
              const turnMessages = [...turn.thinkingMessages, ...(turn.finalMessage ? [turn.finalMessage] : [])];
              const firstTurnSeq = turnMessages.length > 0 ? Math.min(...turnMessages.map(getSeq).filter(s => s > 0)) : 0;

              return (
                <div key={`turn-${idx}`}>
                  {/* Interior gap marker */}
                  {sessionId && firstTurnSeq > 0 && gapSet.has(firstTurnSeq) && firstTurnSeq !== firstSeq && (
                    <div className="mb-3">
                      <GapMarker sessionId={sessionId} beforeSeq={firstTurnSeq} scrollRef={scrollRef} />
                    </div>
                  )}
                  {(turn.thinkingMessages.length > 0 || hasStreaming) && (
                    <ThinkingBox
                      messages={turn.thinkingMessages}
                      isActive={isActive}
                      agent={session.agent}
                      streamingText={hasStreaming ? streaming : undefined}
                    />
                  )}
                  {turn.finalMessage && !hasStreaming && (
                    <MessageBubble message={turn.finalMessage} agent={session.agent} turnImages={collectTurnImages(turn.thinkingMessages)} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Subtle dim overlay when a blocking card is shown */}
        {(permissions.length > 0 || questions.length > 0) && (
          <div className="pointer-events-none absolute inset-0 bg-black/5 dark:bg-black/15 transition-opacity" />
        )}

        {/* Scroll to bottom button */}
        {showScrollBtn && (
          <button
            onClick={scrollToBottom}
            className="absolute right-4 bottom-4 flex items-center gap-1.5 rounded-full bg-surface-secondary px-3 py-1.5 shadow-lg border border-border-primary text-xs font-medium text-text-primary transition-all hover:bg-surface-tertiary active:scale-95"
          >
            {unreadCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-kraki-500 px-1 text-[9px] font-bold text-white">
                {unreadCount}
              </span>
            )}
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
        )}
      </div>

      {isDeviceOnline && (
        permissions.length > 0 ? (
          <div className="flex max-h-[40vh] flex-col overflow-y-auto">
            {permissions.map((perm) => (
              <PermissionInput key={perm.id} permission={perm} />
            ))}
          </div>
        ) : questions.length > 0 ? (
          <QuestionInput question={questions[0]} sessionId={sessionId} />
        ) : (
          <MessageInput sessionId={sessionId} />
        )
      )}
    </div>
  );
}
