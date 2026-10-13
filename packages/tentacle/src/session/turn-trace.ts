/** A turn's steps (trace.jsonl) and the artifacts they produced. */

import { existsSync, readFileSync } from 'node:fs';
import type { ContentRef } from '@kraki/protocol';
import type { TraceLine } from './types.js';

/** Whether a logged user_message (its JSON) starts a new turn. A steer, or an
 *  answer to the agent's question (`answerTo`), belongs to the running turn.
 *  Legacy/corrupt payloads retain the historical boundary behavior. */
export function userMessageStartsTurn(loggedPayload: string): boolean {
  try {
    const parsed = JSON.parse(loggedPayload) as { payload?: { delivery?: string; answerTo?: string } };
    return parsed.payload?.delivery !== 'steer' && !parsed.payload?.answerTo;
  } catch {
    return true;
  }
}

/** Trace entries tagged with a turn's start seq, in recorded order. */
export function readTraceEntries(tracePath: string, turnStartSeq: number): unknown[] {
  if (!existsSync(tracePath)) return [];

  let content: string;
  try {
    content = readFileSync(tracePath, 'utf8');
  } catch {
    return [];
  }

  const entries: unknown[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const trace = JSON.parse(line) as TraceLine;
      if (trace.turnStartSeq !== turnStartSeq) continue;
      entries.push(JSON.parse(trace.payload));
    } catch {
      // Skip corrupted lines.
    }
  }
  return entries;
}

/** User-visible artifact refs (show_image/show_report/show_html) among a turn's trace entries. */
export function turnArtifacts(entries: unknown[]): ContentRef[] {
  const seen = new Set<string>();
  const artifacts: ContentRef[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry as { type?: unknown; payload?: unknown };
    if (message.type !== 'tool_complete' || !message.payload || typeof message.payload !== 'object') continue;
    const payload = message.payload as {
      toolName?: unknown;
      success?: unknown;
      termination?: unknown;
      attachments?: unknown;
    };
    if (payload.success === false || payload.termination !== undefined) continue;
    if (payload.toolName !== 'show_image' && payload.toolName !== 'show_report' && payload.toolName !== 'show_html') continue;
    if (!Array.isArray(payload.attachments)) continue;

    for (const candidate of payload.attachments) {
      const ref = validTurnArtifact(candidate, payload.toolName);
      if (!ref || seen.has(ref.id)) continue;
      seen.add(ref.id);
      artifacts.push(ref);
    }
  }
  return artifacts;
}

function validTurnArtifact(candidate: unknown, toolName: 'show_image' | 'show_report' | 'show_html'): ContentRef | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const ref = candidate as Partial<ContentRef>;
  if (ref.type !== 'content_ref') return null;
  if (typeof ref.id !== 'string' || ref.id.trim().length === 0) return null;
  if (typeof ref.mimeType !== 'string') return null;
  if (typeof ref.size !== 'number' || !Number.isFinite(ref.size) || ref.size < 0) return null;
  if (toolName === 'show_image' && !ref.mimeType.startsWith('image/')) return null;
  if (toolName !== 'show_image' && ref.mimeType !== 'text/html') return null;
  if (ref.name !== undefined && typeof ref.name !== 'string') return null;
  if (ref.caption !== undefined && typeof ref.caption !== 'string') return null;
  if (ref.width !== undefined && (typeof ref.width !== 'number' || !Number.isFinite(ref.width) || ref.width < 0)) return null;
  if (ref.height !== undefined && (typeof ref.height !== 'number' || !Number.isFinite(ref.height) || ref.height < 0)) return null;
  const sanitized: ContentRef = {
    type: 'content_ref',
    id: ref.id,
    mimeType: ref.mimeType,
    size: ref.size,
    ...(ref.caption !== undefined && { caption: ref.caption }),
    ...(ref.name !== undefined && { name: ref.name }),
    ...(ref.width !== undefined && { width: ref.width }),
    ...(ref.height !== undefined && { height: ref.height }),
  };
  return sanitized;
}
