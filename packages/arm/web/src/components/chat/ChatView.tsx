import { memo, useRef, useMemo, useCallback } from 'react';
import { useParams } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { useShallow } from 'zustand/shallow';
import { MessageBubble } from './MessageBubble';
import { ThinkingBox } from './ThinkingBox';
import { MessageInput } from './MessageInput';
import { PermissionInput } from '../actions/PermissionInput';
import { QuestionInput } from '../actions/QuestionInput';
import { useTurns } from '../../hooks/useTurns';
import { useScrollController } from '../../hooks/useScrollController';
import type { ChatMessage } from '../../types/store';
import type { Attachment } from '@kraki/protocol';

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

  // Filter out pending permission bubbles — the blocking card handles them.
  const filteredMessages = useMemo(
    () => messages.filter((msg) => {
      if (msg.type === 'permission' && pendingPermIds.includes(msg.payload.id)) return false;
      return true;
    }),
    [messages, pendingPermIds],
  );

  // First seq for prepend tracking (passed to scroll controller)
  const firstSeq = useMemo(() => {
    const seqs = filteredMessages.map(getSeq).filter(s => s > 0);
    return seqs.length > 0 ? seqs[0] : 0;
  }, [filteredMessages]);

  const rawGrouped = useTurns(filteredMessages);

  const sessionIdle = filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1].type === 'idle';

  // Ensure streaming always attaches to a turn group
  const grouped = useMemo(() => {
    if (!streaming) return rawGrouped;
    const last = rawGrouped[rawGrouped.length - 1];
    if (last && last.type === 'turn' && !last.turn.finalMessage) return rawGrouped;
    return [...rawGrouped, { type: 'turn' as const, turn: { thinkingMessages: [] as ChatMessage[], finalMessage: null } }];
  }, [rawGrouped, streaming]);

  // Index of the element to scroll to when entering an unread session.
  // Priority: pending question > last user message (if idle) > last agent turn.
  const scrollTargetIdx = useMemo(() => {
    for (let i = grouped.length - 1; i >= 0; i--) {
      const g = grouped[i];
      if (g.type === 'standalone' && g.message.type === 'question') {
        const payload = g.message.payload as Record<string, unknown> | undefined;
        if (!payload?.answer) return i;
      }
    }
    if (sessionIdle) {
      for (let i = grouped.length - 1; i >= 0; i--) {
        const g = grouped[i];
        if (g.type === 'standalone' && (g.message.type === 'user_message' || g.message.type === 'send_input')) return i;
      }
    }
    for (let i = grouped.length - 1; i >= 0; i--) {
      const g = grouped[i];
      if (g.type === 'turn' && g.turn.finalMessage) return i;
    }
    return -1;
  }, [grouped, sessionIdle]);

  // ── Scroll controller (all scroll logic lives here) ───

  const scrollRef = useRef<HTMLDivElement>(null);

  const { showScrollBtn, unreadCount, scrollToBottom, handleScroll, hasOlderMessages } = useScrollController(
    scrollRef,
    grouped,
    streaming,
    sessionId,
    sessionIdle,
    storeUnread,
    firstSeq,
  );

  // ── Render ────────────────────────────────────────────

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
            {hasOlderMessages && (
              <div className="flex justify-center py-3">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-kraki-500 border-t-transparent" />
              </div>
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

        {(permissions.length > 0 || questions.length > 0) && (
          <div className="pointer-events-none absolute inset-0 bg-black/5 dark:bg-black/15 transition-opacity" />
        )}

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
