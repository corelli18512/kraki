/** Claude SDK errors → one clear message (the most concrete one wins). */

import { type NormalizedClaudeError } from './claude-session.js';

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function meaningfulClaudeErrorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || /^(success|unknown|error_during_execution)$/i.test(text)) return undefined;
  return text;
}

export function assistantText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return meaningfulClaudeErrorText(text);
}

export function normalizeClaudeSDKError(value: Record<string, unknown>): NormalizedClaudeError {
  const errors = Array.isArray(value.errors)
    ? value.errors.map(meaningfulClaudeErrorText).filter((item): item is string => !!item)
    : [];
  const text = errors.join('; ')
    || assistantText(value.message)
    || meaningfulClaudeErrorText(value.result)
    || meaningfulClaudeErrorText(value.error_message);
  const statusCandidate = value.api_error_status ?? value.apiErrorStatus ?? value.status ?? value.statusCode;
  const status = typeof statusCandidate === 'number' ? statusCandidate : undefined;
  const requestIdCandidate = value.request_id ?? value.requestId;
  const requestId = typeof requestIdCandidate === 'string' ? requestIdCandidate : undefined;
  const category = meaningfulClaudeErrorText(value.error);
  const fallback = status ? `Claude API error (HTTP ${status})` : category ? `Claude API error: ${category}` : 'Claude API request failed';
  const message = text ?? fallback;
  const quality = text ? (status ? 4 : 3) : status ? 2 : category ? 1 : 0;
  return { message, ...(status ? { status } : {}), ...(requestId ? { requestId } : {}), quality };
}

export function preferClaudeError(
  current: NormalizedClaudeError | undefined,
  candidate: NormalizedClaudeError,
): NormalizedClaudeError {
  return !current || candidate.quality > current.quality ? candidate : current;
}
