import type { Attachment } from '@kraki/protocol';
import type { ChatMessage } from '../types/store';

/** TRACE / transient activity types — never top-level chat bubbles. */
const TRACE_TYPES = new Set(['tool_start', 'tool_complete', 'agent_narration', 'active']);

/** Project durable wire/history records into visual chat bubbles.
 *
 * `error` is turn detail, never a top-level bubble. When a turn ends with a
 * terminal status after already emitting its final `agent_message`, merge that
 * reply into the terminal card's draft and render only the terminal card. The
 * raw records remain untouched in storage and continue to feed Steps/replay. */
export function projectSpineMessages(messages: ChatMessage[]): ChatMessage[] {
  const projected: ChatMessage[] = [];
  let segment: ChatMessage[] = [];

  const flush = () => {
    if (segment.length === 0) return;
    const terminalIdx = segment.findLastIndex(
      (msg) => msg.type === 'turn_status' || msg.type === 'interrupted_turn',
    );
    if (terminalIdx >= 0) {
      const terminal = segment[terminalIdx];
      let fallbackDraft = '';
      let fallbackAttachments: Attachment[] | undefined;
      for (let i = terminalIdx - 1; i >= 0; i--) {
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

      for (let i = 0; i < segment.length; i++) {
        const msg = segment[i];
        if (msg.type === 'error' || msg.type === 'agent_message') continue;
        projected.push(i === terminalIdx ? normalizedTerminal : msg);
      }
    } else {
      for (const msg of segment) {
        if (msg.type !== 'error') projected.push(msg);
      }
    }
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
