/**
 * Model-provider failures often reach an adapter as the raw HTTP body, e.g.
 * Pi's `429: {"message":"You've hit your usage limit…","type":"usage_limit_reached"}`.
 * Every app showed that JSON verbatim in the "Turn failed" row. Keep the
 * provider's own sentence (it is the most specific text there is) and the
 * status, drop the JSON envelope. Anything that is not such a body is
 * returned unchanged.
 */
export function readableProviderError(text: string): string {
  const trimmed = text.trim();
  const brace = trimmed.indexOf('{');
  if (brace < 0 || !trimmed.endsWith('}')) return text;
  const prefix = trimmed.slice(0, brace).trim();
  // Only a bare status prefix ("429:", "401", "HTTP 500 -", "Error 429:"),
  // never prose that happens to end with JSON.
  const status = /^(?:(?:http|error|status)\s*)?(\d{3})?\s*[:\-–]?$/i.exec(prefix);
  if (!status) return text;
  let body: unknown;
  try {
    body = JSON.parse(trimmed.slice(brace));
  } catch {
    return text;
  }
  const message = messageOf(body);
  if (!message) return text;
  return status[1] ? `${message} (HTTP ${status[1]})` : message;
}

function messageOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const error = record.error;
  const candidates = [
    error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined,
    record.message,
    typeof error === 'string' ? error : undefined,
    record.detail,
    record.error_description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
