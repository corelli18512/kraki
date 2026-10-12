/** The sidebar preview of a session: its latest stable turn boundary. */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { upgradeLegacyEntry } from './log-file.js';
import { toWellFormedText } from './text.js';
import type { LoggedMessage } from './types.js';

const PREVIEW_MAX = 80;
const PREVIEW_SCAN_CHUNK_BYTES = 32 * 1024;
// Valid inline-image rows currently reach roughly 1.2 MB. Bound reconstruction
// well above that so a corrupt newline-free log cannot grow memory without limit.
const PREVIEW_SCAN_MAX_LINE_BYTES = 16 * 1024 * 1024;
// Keep session-list generation bounded even if a log has no preview boundary.
// This is large enough for the oversized rows seen in real session data while
// avoiding an unbounded synchronous scan of a multi-hundred-megabyte log.
const PREVIEW_SCAN_MAX_BYTES = 32 * 1024 * 1024;
const PREVIEW_SCAN_MAX_LINES = 4096;
const PREVIEW_BOUNDARY_TYPES = new Set([
  'agent_message',
  'user_message',
  'interrupted_turn',
  'turn_status',
  'system_message',
]);

/** Truncate by Unicode code point, never through the middle of an emoji. */
function truncateText(text: string, maxCodePoints: number): string {
  return Array.from(toWellFormedText(text)).slice(0, maxCodePoints).join('');
}

/** Strip common markdown syntax for clean preview display. */
function stripMarkdownForPreview(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateText(stripped, PREVIEW_MAX);
}

/**
 * Extract a sidebar preview = the most recent STABLE turn boundary.
 *
 * A turn boundary is the durable conversation anchor: the `user_message`
 * that began the current (or last) turn, or the agent outcome of the
 * previous turn (final `agent_message`, terminal `turn_status`, aborted
 * `interrupted_turn`, or `system_message` like no-reply). It stays put for
 * the whole turn — tool activity and narration are NOT boundaries.
 *
 * Transient `error` records (503/429 retries) are skipped: they are
 * infrastructure noise, not conversation content, and a turn that fails is
 * represented by its terminal `turn_status` (or falls back to the
 * user_message, which is still the correct anchor). Open questions and
 * permissions are likewise skipped here — they are turn-internal mechanics
 * and are layered on top separately by `enrichSessionList` (the attention
 * override), so they must never come from this file scan.
 *
 * Scans complete JSONL rows backwards in bounded chunks. The current spine
 * has fewer durable row types while retaining dense Session seqs; older logs
 * may still carry tool rows and therefore replay as a sparse filtered spine.
 * An inline-image row can also be much larger than
 * one read chunk.
 */
export function readSessionPreview(sessionId: string, logPath: string): import('@kraki/protocol').SessionPreviewDigest | undefined {
  if (!existsSync(logPath)) return undefined;

  const previewFromLine = (line: string): import('@kraki/protocol').SessionPreviewDigest | undefined => {
    try {
      const entry = upgradeLegacyEntry(JSON.parse(line) as LoggedMessage, sessionId);
      if (!PREVIEW_BOUNDARY_TYPES.has(entry.type)) return undefined;
      const inner = JSON.parse(entry.payload) as { type?: string; payload?: Record<string, unknown> };
      const payload = inner.payload;
      if (!payload) return undefined;

      switch (inner.type) {
        case 'agent_message': {
          // A question reads as an agent line here; whether it is still
          // awaiting an answer is live state (enrichSessionList overlays it).
          const question = payload.question as { text?: unknown } | undefined;
          if (question && typeof question.text === 'string' && question.text) {
            return { text: stripMarkdownForPreview(question.text), type: 'agent', timestamp: entry.ts };
          }
          const content = payload.content;
          if (typeof content === 'string' && content) {
            return { text: stripMarkdownForPreview(content), type: 'agent', timestamp: entry.ts };
          }
          break;
        }
        case 'user_message': {
          const content = payload.content;
          if (typeof content === 'string' && content) {
            return { text: stripMarkdownForPreview(content), type: 'user', timestamp: entry.ts };
          }
          break;
        }
        case 'interrupted_turn': {
          const draft = payload.draft;
          const failed = payload.reason === 'process_lost';
          return {
            text: typeof draft === 'string' && draft ? stripMarkdownForPreview(draft) : (failed ? 'Turn failed' : 'Stopped'),
            type: 'agent',
            timestamp: entry.ts,
          };
        }
        case 'turn_status': {
          const draft = payload.draft;
          const actionType = (payload.action as { type?: string } | undefined)?.type;
          const failed = actionType === 'failed';
          return {
            text: typeof draft === 'string' && draft ? stripMarkdownForPreview(draft) : (failed ? 'Turn failed' : 'Stopped'),
            type: failed ? 'error' : 'agent',
            timestamp: entry.ts,
          };
        }
        case 'system_message': {
          const content = payload.content;
          if (typeof content === 'string' && content) {
            return { text: stripMarkdownForPreview(content), type: 'agent', timestamp: entry.ts };
          }
          // A steps-only turn has no text of its own: fall through to the
          // user's prompt rather than inventing a "No reply" preview.
          if (payload.kind === 'no_reply') break;
          return { text: 'System notice', type: 'agent', timestamp: entry.ts };
        }
        // error / idle / active / session_created / session_ended / tool_* /
        // agent_narration / question / answer / permission / *_resolved /
        // compacting are intentionally NOT turn boundaries — skip them.
      }
    } catch {
      // Skip malformed lines.
    }
    return undefined;
  };

  try {
    const fd = openSync(logPath, 'r');
    try {
      let position = fstatSync(fd).size;
      const scanStart = Math.max(0, position - PREVIEW_SCAN_MAX_BYTES);
      let suffixParts: Buffer[] = [];
      let suffixBytes = 0;
      let discardOversizedLine = false;
      let inspectedLines = 0;
      let lineLimitReached = false;

      const inspectLine = (prefix: Buffer): import('@kraki/protocol').SessionPreviewDigest | undefined => {
        if (discardOversizedLine) {
          discardOversizedLine = false;
          suffixParts = [];
          suffixBytes = 0;
          return undefined;
        }

        const lineBytes = prefix.length + suffixBytes;
        if (lineBytes === 0) return undefined;
        if (inspectedLines >= PREVIEW_SCAN_MAX_LINES) {
          lineLimitReached = true;
          return undefined;
        }
        inspectedLines++;
        if (lineBytes > PREVIEW_SCAN_MAX_LINE_BYTES) {
          suffixParts = [];
          suffixBytes = 0;
          return undefined;
        }

        const line = suffixParts.length === 0
          ? prefix
          : Buffer.concat([prefix, ...suffixParts.reverse()], lineBytes);
        suffixParts = [];
        suffixBytes = 0;
        return previewFromLine(line.toString('utf8'));
      };

      while (position > scanStart) {
        const requested = Math.min(PREVIEW_SCAN_CHUNK_BYTES, position - scanStart);
        position -= requested;
        const buf = Buffer.allocUnsafe(requested);
        const bytesRead = readSync(fd, buf, 0, requested, position);
        if (bytesRead <= 0) break;
        const chunk = bytesRead === requested ? buf : buf.subarray(0, bytesRead);

        let end = chunk.length;
        while (end > 0) {
          const newline = chunk.lastIndexOf(0x0a, end - 1);
          if (newline < 0) break;
          const preview = inspectLine(chunk.subarray(newline + 1, end));
          if (preview) return preview;
          if (lineLimitReached) return undefined;
          end = newline;
        }

        if (end > 0 && !discardOversizedLine) {
          const part = chunk.subarray(0, end);
          if (suffixBytes + part.length > PREVIEW_SCAN_MAX_LINE_BYTES) {
            discardOversizedLine = true;
            suffixParts = [];
            suffixBytes = 0;
          } else {
            suffixParts.push(part);
            suffixBytes += part.length;
          }
        }
      }

      // Only the start of the file is a known line boundary. If the scan hit
      // its byte budget, the remaining suffix may be the tail of a line that
      // began before the window and must not be parsed as a complete record.
      return scanStart === 0 ? inspectLine(Buffer.alloc(0)) : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
