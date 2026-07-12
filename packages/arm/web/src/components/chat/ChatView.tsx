import { memo, useRef, useMemo, useCallback, useEffect } from 'react';
import { useParams } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { MessageBubble } from './MessageBubble';
import { LiveAgentBubble } from './LiveAgentBubble';
import { MessageInput } from './MessageInput';
import { useScrollController } from '../../hooks/useScrollController';
import { messageProvider } from '../../lib/message-provider';
import { getSessionStatus, cardActionKey } from '../../lib/session-status';
import type { Attachment } from '@kraki/protocol';
import type { ChatMessage } from '../../types/store';

const EMPTY_MESSAGES: ChatMessage[] = [];

/** TRACE / transient activity types — never on the spine; they live in the
 *  live bubble (live) or the Steps modal (pulled history). */
const TRACE_TYPES = new Set(['tool_start', 'tool_complete', 'agent_narration', 'active']);

/** Extract seq from a message, returning 0 for non-sequenced messages. */
function getSeq(m: ChatMessage): number {
  return 'seq' in m ? (m as { seq?: number }).seq ?? 0 : 0;
}

function attachmentKey(attachment: Attachment): string {
  if (attachment.type === 'content_ref') return `ref:${attachment.id}`;
  if (attachment.type === 'image') return `image:${attachment.mimeType}:${attachment.data}`;
  return JSON.stringify(attachment);
}

/** Images produced by show_image/tool steps in the turn concluding at
 *  `bubbleSeq`. They stay on the TRACE axis for history, but are also rendered
 *  inside that turn's final agent bubble. */
export function collectTurnImages(
  messages: ChatMessage[],
  bubbleSeq: number,
  directAttachments: Attachment[] = [],
): Attachment[] {
  const directKeys = new Set(directAttachments.map(attachmentKey));
  const targetIdx = messages.findIndex((message) => getSeq(message) === bubbleSeq);
  if (targetIdx < 0 || messages[targetIdx].type !== 'agent_message') return [];
  let turnStartIdx = -1;
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (messages[i].type === 'user_message') {
      turnStartIdx = i;
      break;
    }
  }
  const seen = new Set<string>();
  const images: Attachment[] = [];
  for (let i = turnStartIdx + 1; i < targetIdx; i++) {
    const step = messages[i];
    if (step.type !== 'tool_complete') continue;
    for (const attachment of step.payload.attachments ?? []) {
      const isImage = attachment.type === 'image' ||
        (attachment.type === 'content_ref' && attachment.mimeType.startsWith('image/'));
      if (!isImage) continue;
      const key = attachmentKey(attachment);
      if (directKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      images.push(attachment);
    }
  }
  return images;
}

export const ChatView = memo(function ChatView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const messages = useStore((s) => sessionId ? s.messages.get(sessionId) : undefined) ?? EMPTY_MESSAGES;
  const session = useStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const card = useStore((s) => sessionId ? s.cards.get(sessionId) : undefined);
  const sessionPreview = useStore((s) => sessionId ? s.sessionPreviews.get(sessionId) : undefined);
  const storeUnread = useStore((s) => sessionId ? (s.unreadCount.get(sessionId) ?? 0) : 0);

  // Scoped selectors — only re-render when THIS session's data changes
  const deviceId = session?.deviceId;
  const isDeviceOnline = useStore(
    useCallback((s) => deviceId ? s.devices.get(deviceId)?.online ?? false : false, [deviceId]),
  );
  // Whether the tentacle device is encryptable yet — a `request_card` snapshot
  // pull needs its key, which may arrive AFTER this view first mounts (fresh
  // reload). Gate + re-trigger the seed effect on this so the pull isn't lost.
  const isTentacleEncryptable = useStore(
    useCallback((s) => {
      const d = deviceId ? s.devices.get(deviceId) : undefined;
      return !!(d?.encryptionKey ?? d?.publicKey);
    }, [deviceId]),
  );

  // ── SPINE ─────────────────────────────────────────────
  // Persistent, replayed bubbles rendered directly in seq order. Excludes the
  // transient TRACE/activity axis (tool_start/tool_complete/agent_narration/
  // active), which is shown only from the Steps popover.
  const spine = useMemo(
    () => messages.filter((msg) => {
      if (TRACE_TYPES.has(msg.type)) return false;
      return true;
    }),
    [messages],
  );
  const finalAgentSeqs = useMemo(() => {
    const seqs = new Set<number>();
    let lastAgentSeq = 0;
    for (const msg of spine) {
      if (msg.type === 'user_message') {
        if (lastAgentSeq > 0) seqs.add(lastAgentSeq);
        lastAgentSeq = 0;
      } else if (msg.type === 'agent_message') {
        lastAgentSeq = getSeq(msg);
      }
    }
    if (lastAgentSeq > 0) seqs.add(lastAgentSeq);
    return seqs;
  }, [spine]);
  const turnImagesByBubbleSeq = useMemo(() => {
    const bySeq = new Map<number, Attachment[]>();
    for (const msg of spine) {
      if (msg.type !== 'agent_message') continue;
      const seq = getSeq(msg);
      if (!finalAgentSeqs.has(seq)) continue;
      const images = collectTurnImages(messages, seq, msg.payload.attachments);
      if (images.length > 0) bySeq.set(seq, images);
    }
    return bySeq;
  }, [finalAgentSeqs, messages, spine]);

  // Derived human-facing status decides card visibility.
  const cardAction = card?.action;
  // What the live bubble's lower ACTION section shows — driven purely by what
  // is in the slot, NOT by a generic "working" status:
  //   • a running tool / concurrent batch (in-flight work), or
  //   • a COMPLETED tool / RESOLVED prompt that is the most recent activity — the
  //     tentacle retires it from the slot the instant narration resumes, so its
  //     presence means "the latest thing that happened was this action", or
  //   • an unresolved permission / question (a blocking human affordance).
  // A decided permission / answered question therefore keeps the bubble pinned
  // (showing its read-only outcome) only until the agent narrates again.
  const actionLive =
    cardAction?.type === 'tool_start' ||
    cardAction?.type === 'tool_complete' ||
    (cardAction?.type === 'tool_batch' && cardAction.payload.running > 0) ||
    cardAction?.type === 'permission' ||
    cardAction?.type === 'question';
  const livePending =
    (cardAction?.type === 'question' && cardAction.payload.answer === undefined && !cardAction.payload.cancelled) ||
    (cardAction?.type === 'permission' && !cardAction.payload.decision)
      ? 1
      : 0;
  const status = useMemo(
    () => session ? getSessionStatus(session, livePending, sessionPreview?.type) : 'idle',
    [session, livePending, sessionPreview?.type],
  );
  // The whole in-progress turn renders as ONE live agent bubble (LiveAgentBubble):
  // its top part streams the draft narration, its darker bottom part carries the
  // live status (Working…/Waiting) + a Steps entry + the CURRENT live action.
  // It shows while the session is non-idle AND there is something live to show —
  // streaming draft text OR a live action. The moment the concluding
  // agent_message lands on the spine (the draft clears) and no action is live,
  // this bubble drops and the concluded spine bubble takes over in place, so
  // there is no card↔bubble morph and no lingering "answered" card.
  const draft = card?.text ?? '';
  const cardEligible = status === 'working' || status === 'pending';
  const showLive = cardEligible && !!card && (draft.length > 0 || actionLive);

  // First seq for prepend tracking (passed to scroll controller)
  const firstSeq = useMemo(() => {
    const seqs = spine.map(getSeq).filter(s => s > 0);
    return seqs.length > 0 ? seqs[0] : 0;
  }, [spine]);

  // Reload mid-turn seed: the server owns the card, so request a snapshot when
  // opening a non-idle session without local card state. Gated on the tentacle
  // being encryptable (its key may arrive after mount) and re-runs when it does.
  useEffect(() => {
    if (!sessionId || !cardEligible || card) return;
    if (!isTentacleEncryptable) return;
    messageProvider.requestCard(sessionId);
  }, [sessionId, cardEligible, card, isTentacleEncryptable]);

  useEffect(() => {
    if (!sessionId || !isTentacleEncryptable) return;
    for (let i = spine.length - 1; i >= 0; i--) {
      const msg = spine[i];
      if (msg.type === 'agent_message' || msg.type === 'interrupted_turn') {
        if ((msg.payload.steps ?? 0) > 0) messageProvider.requestTurnTrace(sessionId, getSeq(msg));
        break;
      }
      if (msg.type === 'user_message') break;
    }
  }, [sessionId, isTentacleEncryptable, spine]);

  // `idle` here is the message-level marker (last spine entry is an idle
  // event), used by the scroll controller for the working→idle reposition. It
  // is distinct from the derived `status`.
  const sessionIdle = spine.length > 0 && spine[spine.length - 1].type === 'idle';

  // Index (into spine) of the element to scroll to when entering an unread
  // session. Priority: last user message (if idle) > last concluded agent
  // bubble. A pending ask_user question now lives in the live bubble at the
  // bottom (auto-followed by the scroll controller), so it needs no spine
  // scroll target.
  const scrollTargetIdx = useMemo(() => {
    if (sessionIdle) {
      for (let i = spine.length - 1; i >= 0; i--) {
        const msg = spine[i];
        if (msg.type === 'user_message' || msg.type === 'send_input') return i;
      }
    }
    for (let i = spine.length - 1; i >= 0; i--) {
      if (spine[i].type === 'agent_message' || spine[i].type === 'interrupted_turn') return i;
    }
    return -1;
  }, [spine, sessionIdle]);

  // The scroll controller tracks content growth. Include the live draft bubble
  // and card action so new narration deltas / tool steps drive auto-follow just
  // like spine bubbles.
  const scrollList = useMemo(
    () => (card && showLive ? [...spine, { _draft: draft, _act: cardActionKey(card.action) } as unknown as ChatMessage] : spine),
    [showLive, spine, card, draft],
  );

  // ── Scroll controller (all scroll logic lives here) ───

  const scrollRef = useRef<HTMLDivElement>(null);

  const { showScrollBtn, unreadCount, scrollToBottom, handleScroll, hasOlderMessages } = useScrollController(
    scrollRef,
    scrollList,
    card?.text,
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
            {spine.map((msg, idx) => (
              <div key={`b-${getSeq(msg) || idx}-${msg.type}`} {...(idx === scrollTargetIdx ? { 'data-scroll-target': '' } : {})}>
                <MessageBubble
                  message={msg}
                  agent={session.agent}
                  sessionId={sessionId}
                  turnImages={msg.type === 'agent_message' ? turnImagesByBubbleSeq.get(getSeq(msg)) : undefined}
                />
              </div>
            ))}
            {showLive && card && (
              <LiveAgentBubble
                sessionId={sessionId}
                agent={session.agent}
                card={card}
              />
            )}
          </div>
        </div>

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

      {isDeviceOnline && <MessageInput sessionId={sessionId} />}
    </div>
  );
});
