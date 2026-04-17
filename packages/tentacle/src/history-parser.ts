/**
 * History parser — converts Copilot SDK events.jsonl into Kraki protocol messages.
 *
 * Used during import to backfill conversation history so the arm can display
 * the full session context from before Kraki attached.
 *
 * Reads events.jsonl line by line (streaming) to handle large files.
 * Caps output at MAX_BACKFILL_MESSAGES most recent messages.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('history-parser');

/** Max messages to backfill from events.jsonl (most recent kept). */
const MAX_BACKFILL_MESSAGES = 500;

// ── SDK event types we care about ───────────────────────

interface SdkEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
}

// ── Converted message format (matches SessionManager's LoggedMessage) ──

export interface BackfilledMessage {
  seq: number;
  type: string;
  payload: string; // JSON-stringified payload
  ts: string;
}

// ── Session metadata extracted from events.jsonl ────────

export interface ParsedSessionMeta {
  model?: string;
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  repository?: string;
}

// ── Parser ──────────────────────────────────────────────

/**
 * Parse a Copilot SDK events.jsonl file into Kraki protocol messages.
 * Returns up to MAX_BACKFILL_MESSAGES most recent messages and session metadata.
 */
export function parseEventsFile(eventsPath: string): {
  messages: BackfilledMessage[];
  meta: ParsedSessionMeta;
} {
  if (!existsSync(eventsPath)) {
    return { messages: [], meta: {} };
  }

  const messages: BackfilledMessage[] = [];
  const meta: ParsedSessionMeta = {};
  let seq = 0;

  // Stream line by line using a buffer to handle large files
  const content = readFileChunked(eventsPath);

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let event: SdkEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // skip corrupt lines
    }

    const ts = event.timestamp ?? new Date().toISOString();
    const converted = convertEvent(event, ts, meta);
    if (converted) {
      seq++;
      messages.push({ seq, ...converted });
    }
  }

  // Keep only the most recent messages
  if (messages.length > MAX_BACKFILL_MESSAGES) {
    const trimmed = messages.slice(messages.length - MAX_BACKFILL_MESSAGES);
    // Re-number seq starting from 1
    for (let i = 0; i < trimmed.length; i++) {
      trimmed[i].seq = i + 1;
    }
    return { messages: trimmed, meta };
  }

  return { messages, meta };
}

/**
 * Parse events.jsonl from a session directory.
 */
export function parseSessionHistory(sessionDir: string): {
  messages: BackfilledMessage[];
  meta: ParsedSessionMeta;
} {
  return parseEventsFile(join(sessionDir, 'events.jsonl'));
}

// ── Event conversion ────────────────────────────────────

function convertEvent(
  event: SdkEvent,
  ts: string,
  meta: ParsedSessionMeta,
): { type: string; payload: string; ts: string } | null {
  switch (event.type) {
    case 'session.start': {
      // Extract metadata, don't emit a message
      const ctx = event.data.context as Record<string, string> | undefined;
      if (event.data.selectedModel) meta.model = event.data.selectedModel as string;
      if (ctx?.cwd) meta.cwd = ctx.cwd;
      if (ctx?.gitRoot) meta.gitRoot = ctx.gitRoot;
      if (ctx?.branch) meta.branch = ctx.branch;
      if (ctx?.repository) meta.repository = ctx.repository;
      return null;
    }

    case 'user.message': {
      const content = event.data.content as string ?? '';
      // Use transformedContent if available (has system context stripped)
      return {
        type: 'user_message',
        payload: JSON.stringify({ content }),
        ts,
      };
    }

    case 'assistant.message': {
      const content = event.data.content as string ?? '';
      if (!content) return null; // skip empty messages (SDK sends these before tool calls)
      return {
        type: 'agent_message',
        payload: JSON.stringify({ content }),
        ts,
      };
    }

    case 'tool.execution_start': {
      const toolName = event.data.toolName as string ?? 'unknown';
      const args = (event.data.arguments ?? event.data.args ?? {}) as Record<string, unknown>;
      const toolCallId = event.data.toolCallId as string | undefined;
      return {
        type: 'tool_start',
        payload: JSON.stringify({ toolName, args, toolCallId }),
        ts,
      };
    }

    case 'tool.execution_complete': {
      const toolName = event.data.toolName as string ?? 'unknown';
      const toolCallId = event.data.toolCallId as string | undefined;
      const success = event.data.success as boolean | undefined;
      const rawResult = event.data.result;
      const resultObj = typeof rawResult === 'object' && rawResult !== null
        ? rawResult as Record<string, unknown>
        : null;
      const result = resultObj?.content as string
        ?? (typeof rawResult === 'string' ? rawResult : (event.data.output as string ?? ''));

      return {
        type: 'tool_complete',
        payload: JSON.stringify({
          toolName,
          args: {},
          result: result.slice(0, 5000), // Cap result size for backfill
          toolCallId,
          success,
        }),
        ts,
      };
    }

    case 'assistant.turn_end': {
      return {
        type: 'idle',
        payload: JSON.stringify({}),
        ts,
      };
    }

    // Skip events that don't map to Kraki messages
    case 'assistant.message_delta':
    case 'assistant.turn_start':
    case 'hook.start':
    case 'hook.end':
    case 'subagent.started':
    case 'session.idle':
    case 'session.shutdown':
    case 'session.info':
    case 'session.warning':
    case 'session.task_complete':
    case 'assistant.usage':
    case 'session.title_changed':
      return null;

    default:
      // Unknown event type — skip
      return null;
  }
}

// ── File reading helper ─────────────────────────────────

function readFileChunked(filePath: string): string {
  // For files under 10MB, just read the whole thing
  const stat = statSync(filePath);
  if (stat.size <= 10 * 1024 * 1024) {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size);
    readSync(fd, buf, 0, stat.size, 0);
    closeSync(fd);
    return buf.toString('utf8');
  }

  // For larger files, read in chunks
  logger.info({ filePath, size: stat.size }, 'Large events.jsonl — reading in chunks');
  const fd = openSync(filePath, 'r');
  const chunks: Buffer[] = [];
  const chunkSize = 1024 * 1024; // 1MB chunks
  let offset = 0;

  while (offset < stat.size) {
    const readSize = Math.min(chunkSize, stat.size - offset);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, offset);
    chunks.push(buf);
    offset += readSize;
  }

  closeSync(fd);
  return Buffer.concat(chunks).toString('utf8');
}
