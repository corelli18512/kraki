import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useParams } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { MessageBubble } from './MessageBubble';
import { StreamingText } from './StreamingText';
import { MessageInput } from './MessageInput';
import { PermissionInput } from '../actions/PermissionInput';
import { QuestionInput } from '../actions/QuestionInput';

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

  // Filter out pending permission/question bubbles from chat — the blocking card handles them
  const visibleMessages = useMemo(
    () => messages.filter((msg) => {
      if (msg.type === 'permission' && pendingPermIds.has(msg.payload.id)) return false;
      if (msg.type === 'question' && pendingQuestionIds.has(msg.payload.id)) return false;
      return true;
    }),
    [messages, pendingPermIds, pendingQuestionIds],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

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
      setUnreadCount((c) => c + 1);
      setShowScrollBtn(true);
    }
  }, [messages, streaming, scrollToBottom]);

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
            {visibleMessages.map((msg, idx) => (
              <MessageBubble key={'seq' in msg && msg.seq ? `${msg.seq}-${msg.type}` : `local-${idx}`} message={msg} agent={session.agent} />
            ))}

            {streaming && <StreamingText content={streaming} agent={session.agent} />}
          </div>
        </div>

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
          <PermissionInput permission={permissions[0]} />
        ) : questions.length > 0 ? (
          <QuestionInput question={questions[0]} sessionId={sessionId} />
        ) : (
          <MessageInput sessionId={sessionId} />
        )
      )}
    </div>
  );
}
