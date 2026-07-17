import type { Attachment, ContentRef } from '@kraki/protocol';
import type { ChatMessage } from '../types/store';

/** TRACE / transient activity types — never top-level chat bubbles. */
const TRACE_TYPES = new Set(['tool_start', 'tool_complete', 'agent_narration', 'active']);

function attachmentKey(attachment: Attachment): string {
  return attachment.type === 'content_ref'
    ? `ref:${attachment.id}`
    : `image:${attachment.mimeType}:${attachment.data}`;
}

function withTurnArtifacts(message: ChatMessage, artifacts: ContentRef[]): ChatMessage {
  if (artifacts.length === 0) return message;
  const payload = message.payload as { attachments?: Attachment[] };
  const existing = payload.attachments ?? [];
  const seen = new Set(existing.map(attachmentKey));
  const merged = [...existing];
  for (const artifact of artifacts) {
    const key = attachmentKey(artifact);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(artifact);
  }
  return {
    ...message,
    payload: { ...message.payload, attachments: merged },
  } as ChatMessage;
}

/** Project durable wire/history records into visual chat bubbles.
 *
 * `error` is turn detail, never a top-level bubble. When a turn ends with a
 * terminal status after already emitting its final `agent_message`, merge that
 * reply into the terminal card and render only the terminal card. The closing
 * idle's `turnArtifacts` are durable spine metadata projected onto the visible
 * outcome anchor; idle itself remains non-visual. */
export function projectSpineMessages(messages: ChatMessage[]): ChatMessage[] {
  const projected: ChatMessage[] = [];
  let segment: ChatMessage[] = [];

  const flush = () => {
    if (segment.length === 0) return;
    const closingIdle = [...segment].reverse().find((msg) => msg.type === 'idle');
    const turnArtifacts = ((closingIdle?.payload as { turnArtifacts?: ContentRef[] } | undefined)?.turnArtifacts ?? [])
      .filter((artifact): artifact is ContentRef => artifact?.type === 'content_ref');

    const terminalIdx = segment.findLastIndex((msg) => msg.type === 'turn_status');
    const interruptedIdx = segment.findLastIndex((msg) => msg.type === 'interrupted_turn');
    const outcomeIdx = terminalIdx >= 0 ? terminalIdx : interruptedIdx;

    let visibleSegment: ChatMessage[];
    let visibleOutcomeIdx = -1;
    if (outcomeIdx >= 0) {
      const terminal = segment[outcomeIdx];
      let fallbackDraft = '';
      let fallbackAttachments: Attachment[] | undefined;
      for (let i = outcomeIdx - 1; i >= 0; i--) {
        const candidate = segment[i];
        if (candidate.type === 'agent_message') {
          const attachments = candidate.payload.attachments;
          if (candidate.payload.content || attachments?.length) {
            fallbackDraft = candidate.payload.content ?? '';
            fallbackAttachments = attachments;
            break;
          }
        }
      }
      const ownDraft = terminal.payload.draft ?? '';
      const terminalAttachments = (terminal.payload as { attachments?: Attachment[] }).attachments;
      const hasFallback = !!fallbackDraft || !!fallbackAttachments?.length;
      const needsMerge = hasFallback && (!ownDraft || (!terminalAttachments?.length && !!fallbackAttachments?.length));
      const normalizedTerminal = !needsMerge
        ? terminal
        : ({
            ...terminal,
            payload: {
              ...terminal.payload,
              draft: ownDraft || fallbackDraft,
              ...(!terminalAttachments?.length && fallbackAttachments?.length
                ? { attachments: fallbackAttachments }
                : {}),
            },
          } as ChatMessage);

      visibleSegment = [];
      for (let i = 0; i < segment.length; i++) {
        const msg = segment[i];
        if (msg.type === 'error' || msg.type === 'agent_message') continue;
        if (i === outcomeIdx) visibleOutcomeIdx = visibleSegment.length;
        visibleSegment.push(i === outcomeIdx ? normalizedTerminal : msg);
      }
    } else {
      visibleSegment = segment.filter((msg) => msg.type !== 'error');
      visibleOutcomeIdx = visibleSegment.findLastIndex((msg) => msg.type === 'agent_message');
      if (visibleOutcomeIdx < 0) {
        visibleOutcomeIdx = visibleSegment.findLastIndex((msg) => msg.type === 'system_message');
      }
    }

    if (visibleOutcomeIdx >= 0 && turnArtifacts.length > 0) {
      visibleSegment[visibleOutcomeIdx] = withTurnArtifacts(visibleSegment[visibleOutcomeIdx], turnArtifacts);
    }
    projected.push(...visibleSegment);
    segment = [];
  };

  for (const msg of messages) {
    if (TRACE_TYPES.has(msg.type)) continue;
    segment.push(msg);
    if (msg.type === 'idle') flush();
  }
  flush();
  return projected;
}
