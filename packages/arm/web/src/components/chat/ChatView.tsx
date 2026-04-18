import { memo, useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, type MutableRefObject } from 'react';
import { useParams } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { useShallow } from 'zustand/shallow';
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

export const ChatView = memo(function ChatView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const messages = useStore((s) => sessionId ? s.messages.get(sessionId) : undefined) ?? EMPTY_MESSAGES;
  const streaming = useStore((s) => sessionId ? s.streamingContent.get(sessionId) : undefined);
  const session = useStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const storeUnread = useStore((s) => sessionId ? (s.unreadCount.get(sessionId) ?? 0) : 0);

  // Scoped selectors — only re-render when THIS session's data changes
  const deviceId = session?.deviceId;
  const isDeviceOnline = useStore(
    useCallback((s) => deviceId ? s.devices.get(deviceId)?.online ?? false : false, [deviceId]),
  );

  // Session-scoped pending permission IDs (sorted array for shallow stability)
  const pendingPermIds = useStore(
    useShallow((s) => {
      const ids: string[] = [];
      for (const p of s.pendingPermissions.values()) {
        if (p.sessionId === sessionId) ids.push(p.id);
      }
      return ids.sort();
    }),
  );

  // Session-scoped permissions and questions lists
  const permissions = useStore(
    useShallow((s) => [...s.pendingPermissions.values()].filter((p) => p.sessionId === sessionId)),
  );
  const questions = useStore(
    useShallow((s) => [...s.pendingQuestions.values()].filter((q) => q.sessionId === sessionId)),
  );

  const hadUnreadRef = useRef(false);
  /** Set when older messages are prepended — gates the scroll-preservation layout effect. */
  const prependedRef = useRef(false);

  // Filter out pending permission bubbles — the blocking card handles them.
  // Questions are always shown as normal chat bubbles.
  const filteredMessages = useMemo(
    () => messages.filter((msg) => {
      if (msg.type === 'permission' && pendingPermIds.includes(msg.payload.id)) return false;
      return true;
    }),
    [messages, pendingPermIds],
  );

  // Show spinner at top if there are older messages not yet loaded
  const firstSeq = useMemo(() => {
    const seqs = filteredMessages.map(getSeq).filter(s => s > 0);
    return seqs.length > 0 ? seqs[0] : 0;
  }, [filteredMessages]);
  const hasOlderMessages = firstSeq > 1;
  const prevFirstSeqRef = useRef(firstSeq);
  if (firstSeq > 0 && prevFirstSeqRef.current > 0 && firstSeq < prevFirstSeqRef.current) {
    prependedRef.current = true;
  }
  prevFirstSeqRef.current = firstSeq;

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

  // Index of the element to scroll to when entering an unread session.
  // Priority: pending question > last user message (if idle) > last agent turn.
  // (Pending permissions are filtered out of chat and shown as a blocking card at bottom.)
  const scrollTargetIdx = useMemo(() => {
    // Pending question — scroll to its chat bubble
    for (let i = grouped.length - 1; i >= 0; i--) {
      const g = grouped[i];
      if (g.type === 'standalone' && g.message.type === 'question') {
        const payload = g.message.payload as Record<string, unknown> | undefined;
        if (!payload?.answer) return i;
      }
    }
    // Idle — scroll to the last user message (the prompt they sent)
    if (sessionIdle) {
      for (let i = grouped.length - 1; i >= 0; i--) {
        const g = grouped[i];
        if (g.type === 'standalone' && (g.message.type === 'user_message' || g.message.type === 'send_input')) return i;
      }
    }
    // Default — last completed agent turn
    for (let i = grouped.length - 1; i >= 0; i--) {
      const g = grouped[i];
      if (g.type === 'turn' && g.turn.finalMessage) return i;
    }
    return -1;
  }, [grouped, sessionIdle]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const prevMsgLenRef: MutableRefObject<number> = useRef(0);
  const prevLastSeqRef = useRef(0);
  const prevScrollHeightRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      logger.info('SCROLL scrollToBottom', { from: el.scrollTop, to: el.scrollHeight, trace: new Error().stack?.split('\n').slice(1, 4).map(s => s.trim()) });
      el.scrollTop = el.scrollHeight;
    }
    setShowScrollBtn(false);
    setUnreadCount(0);
  }, []);

  // Preserve scroll position: prepend adjustment (before paint)
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const prevHeight = prevScrollHeightRef.current;
    const heightGrew = prevHeight > 0 && el.scrollHeight > prevHeight;
    const heightShrank = prevHeight > 0 && el.scrollHeight < prevHeight;
    if (heightGrew || heightShrank) {
      logger.info('SCROLL layoutEffect heightChange', { prevHeight, newHeight: el.scrollHeight, scrollTop: el.scrollTop, prepended: prependedRef.current, atBottom: isAtBottomRef.current });
    }
    if (prependedRef.current && heightGrew && !isAtBottomRef.current) {
      logger.info('SCROLL layoutEffect prepend adjust', { from: el.scrollTop, delta: el.scrollHeight - prevHeight });
      el.scrollTop += el.scrollHeight - prevHeight;
    }
    prependedRef.current = false;
    prevScrollHeightRef.current = el.scrollHeight;
  });

  // Track whether the previous render was idle (to detect idle transition)
  const wasIdleRef = useRef(sessionIdle);

  // Auto-scroll to bottom when new messages arrive (only if already at bottom)
  useEffect(() => {
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

    const lastGroup = curLen > 0 ? grouped[curLen - 1] : null;
    const isFromUser = lastGroup?.type === 'standalone' && (
      lastGroup.message.type === 'user_message' ||
      lastGroup.message.type === 'pending_input' ||
      lastGroup.message.type === 'answer' ||
      lastGroup.message.type === 'send_input'
    );

    // On idle transition: if the response is long, scroll user message to top
    const justWentIdle = sessionIdle && !wasIdleRef.current;
    wasIdleRef.current = sessionIdle;

    if (justWentIdle && isAtBottomRef.current && scrollRef.current) {
      const container = scrollRef.current;
      const target = container.querySelector<HTMLElement>('[data-scroll-target]');
      if (target) {
        const targetTop = target.offsetTop;
        const contentBelow = container.scrollHeight - targetTop;
        if (contentBelow > container.clientHeight) {
          logger.info('SCROLL justWentIdle → scrollIntoView', { targetTop, contentBelow, clientHeight: container.clientHeight, scrollTop: container.scrollTop });
          target.scrollIntoView({ block: 'start' });
          container.scrollTop = Math.max(0, container.scrollTop - 12);
          isAtBottomRef.current = false;
          prevMsgLenRef.current = curLen;
          prevLastSeqRef.current = curLastSeq;
          return;
        }
      }
      logger.info('SCROLL justWentIdle → scrollToBottom (fits)');
      scrollToBottom();
    } else if (isAtBottomRef.current || isFromUser) {
      logger.info('SCROLL autoScroll → scrollToBottom', { atBottom: isAtBottomRef.current, isFromUser, curLen, curLastSeq });
      scrollToBottom();
    } else if (isNewAtEnd) {
      const prevLen = prevMsgLenRef.current;
      if (curLen > prevLen) {
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
  }, [grouped, streaming, sessionIdle, scrollToBottom]);

  // Snapshot unread state before SessionPage clears it
  useEffect(() => {
    hadUnreadRef.current = storeUnread > 0;
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps -- capture on session entry only

  // Reset when switching sessions
  useEffect(() => {
    setShowScrollBtn(false);
    setUnreadCount(0);
    isAtBottomRef.current = true;
    prependedRef.current = false;
    prevFirstSeqRef.current = 0;
    // Scroll after DOM settles
    setTimeout(() => {
      const container = scrollRef.current;
      if (!container) return;

      // If session had unread messages, try to scroll to the relevant element:
      // pending question/permission, last user message (idle), or last agent bubble.
      if (hadUnreadRef.current) {
        const target = container.querySelector<HTMLElement>('[data-scroll-target]');
        if (target) {
          const targetTop = target.offsetTop;
          const contentBelow = container.scrollHeight - targetTop;
          if (contentBelow > container.clientHeight) {
            logger.info('SCROLL sessionSwitch → scrollIntoView (unread)', { targetTop, contentBelow, clientHeight: container.clientHeight });
            target.scrollIntoView({ block: 'start' });
            container.scrollTop = Math.max(0, container.scrollTop - 12);
            isAtBottomRef.current = false;
            return;
          }
        }
      }

      logger.info('SCROLL sessionSwitch → scrollToHeight', { scrollHeight: container.scrollHeight });
      container.scrollTop = container.scrollHeight;
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
          data-chat-scroll
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
                return (
                  <div key={`g-${idx}`} {...(idx === scrollTargetIdx ? { 'data-scroll-target': '' } : {})}>
                    <MessageBubble
                      message={msg}
                      agent={session.agent}
                      sessionId={sessionId}
                    />
                  </div>
                );
              }

              const { turn } = item;
              const isLastTurn = idx === grouped.length - 1;
              const hasStreaming = isLastTurn && !!streaming;
              const isActive = isLastTurn && !sessionIdle && (!turn.finalMessage || hasStreaming);

              return (
                <div key={`turn-${idx}`} {...(idx === scrollTargetIdx ? { 'data-scroll-target': '' } : {})}>
                  {(turn.thinkingMessages.length > 0 || hasStreaming) && (
                    <ThinkingBox
                      messages={turn.thinkingMessages}
                      isActive={isActive}
                      aborted={turn.aborted}
                      agent={session.agent}
                      sessionId={sessionId}
                      streamingText={hasStreaming ? streaming : undefined}
                    />
                  )}
                  {turn.finalMessage && !hasStreaming && (
                    <MessageBubble message={turn.finalMessage} agent={session.agent} sessionId={sessionId} turnImages={collectTurnImages(turn.thinkingMessages)} />
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
});
