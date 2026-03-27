import { useEffect, useRef, useMemo, useState, useCallback, type MutableRefObject } from 'react';
import { useParams } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { MessageBubble } from './MessageBubble';
import { StreamingText } from './StreamingText';
import { ThinkingBox } from './ThinkingBox';
import { MessageInput } from './MessageInput';
import { PermissionInput } from '../actions/PermissionInput';
import { QuestionInput } from '../actions/QuestionInput';
import { useTurns } from '../../hooks/useTurns';

const EMPTY_MESSAGES: import('../../types/store').ChatMessage[] = [];

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
  const pendingQuestionIds = useMemo(
    () => new Set([...questionsMap.values()].map((q) => q.id)),
    [questionsMap],
  );

  const permissions = useMemo(
    () => [...permissionsMap.values()].filter((p) => p.sessionId === sessionId),
    [permissionsMap, sessionId],
  );
  const questions = useMemo(
    () => [...questionsMap.values()].filter((q) => q.sessionId === sessionId),
    [questionsMap, sessionId],
  );

  // Filter out pending permission/question bubbles — the blocking card handles them
  // Also filter out approve/deny/always_allow (they return null anyway)
  const filteredMessages = useMemo(
    () => messages.filter((msg) => {
      if (msg.type === 'permission' && pendingPermIds.has(msg.payload.id)) return false;
      if (msg.type === 'question' && pendingQuestionIds.has(msg.payload.id)) return false;
      return true;
    }),
    [messages, pendingPermIds, pendingQuestionIds],
  );

  const grouped = useTurns(filteredMessages);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const prevMsgLenRef: MutableRefObject<number> = useRef(0);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    setShowScrollBtn(false);
    setUnreadCount(0);
  }, []);

  // Auto-scroll to bottom when new messages arrive (only if already at bottom)
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    } else {
      // Only count messages from others (agent, system) as unread — not the user's own
      const prevLen = prevMsgLenRef.current;
      const curLen = messages.length;
      if (curLen > prevLen) {
        const lastMsg = messages[curLen - 1];
        const isFromUser = lastMsg && (
          lastMsg.type === 'user_message' ||
          lastMsg.type === 'pending_input' ||
          lastMsg.type === 'answer' ||
          lastMsg.type === 'send_input'
        );
        if (!isFromUser) {
          setUnreadCount((c) => c + 1);
          setShowScrollBtn(true);
        }
      } else if (streaming) {
        setShowScrollBtn(true);
      }
    }
    prevMsgLenRef.current = messages.length;
  }, [messages, streaming, permissions, questions, scrollToBottom]);

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
            {grouped.map((item, idx) => {
              if (item.type === 'standalone') {
                const msg = item.message;
                return (
                  <MessageBubble
                    key={'seq' in msg && msg.seq ? `${msg.seq}-${msg.type}` : `local-${idx}`}
                    message={msg}
                    agent={session.agent}
                  />
                );
              }

              const { turn } = item;
              const isActiveTurn = !turn.finalMessage && !streaming;
              const isStreamingTurn = !turn.finalMessage && !!streaming;

              return (
                <div key={`turn-${idx}`}>
                  {turn.thinkingMessages.length > 0 && (
                    <ThinkingBox
                      messages={turn.thinkingMessages}
                      isActive={isActiveTurn || isStreamingTurn}
                      agent={session.agent}
                    />
                  )}
                  {turn.finalMessage && (
                    <MessageBubble message={turn.finalMessage} agent={session.agent} />
                  )}
                </div>
              );
            })}

            {streaming && <StreamingText content={streaming} agent={session.agent} />}
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
