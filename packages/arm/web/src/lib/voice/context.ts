/**
 * What may help correction, never what may leak: Mac/iOS
 * VoiceSessionContextBuilder + VoiceContextTermFilter. Only spelling-relevant
 * identifiers from recent messages, never whole messages, never secret-like
 * tokens, URLs, paths or addresses.
 */
const SECRET_PREFIXES = [
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'sk-', 'sk_live_', 'sk_test_', 'rk_live_',
  'pk_live_', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-', 'xapp-', 'AIza', 'ya29.', 'npm_', 'hf_',
  'eyJ', 'dop_v1_', 'shpat_', '-----BEGIN',
];

export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export function isSensitive(raw: string): boolean {
  const t = raw.trim();
  if (SECRET_PREFIXES.some((p) => t.startsWith(p))) return true;
  if (t.length === 20 && (t.startsWith('AKIA') || t.startsWith('ASIA')) && /^[A-Z0-9]+$/.test(t)) return true;
  if (t.includes('://') || t.includes('@') || t.includes('/') || t.includes('\\')) return true;
  if (t.includes(':') && /^\d+$/.test(t.split(':').pop() ?? '')) return true;
  if (t.length >= 12 && /^[0-9a-fA-F]+$/.test(t) && /\d/.test(t)) return true;
  const digits = (t.match(/\d/g) ?? []).length;
  if (t.length >= 16 && digits >= 3 && entropy(t) >= 3.5) return true;
  return false;
}

export interface VoiceContext {
  fields: Record<string, unknown>;
  vocabulary: string[];
}

const locale = () => (typeof navigator !== 'undefined' ? navigator.language : 'en');
const base = () => ({ product: 'kraki', inputMethod: 'dictation', locale: locale() });

function merged(userWords: string[], terms: string[], prefix: boolean): string[] {
  return userWords.concat(terms.filter((term) => !userWords.some((w) => (prefix ? w.toLowerCase().startsWith(term.toLowerCase()) : w.toLowerCase() === term.toLowerCase()))));
}

/** A session's context: title, agent, model and terms from recent messages. */
export function sessionContext(
  session: { id: string; title?: string; agent: string; model?: string; mode?: string },
  recentTexts: string[],
  userWords: string[],
  shareConversation: boolean,
): VoiceContext {
  if (!shareConversation) return { fields: base(), vocabulary: userWords };
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (c: string) => {
    const v = c.trim();
    if (v.length < 2 || v.length > 48 || !/\p{L}/u.test(v)) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); terms.push(v);
  };
  const title = session.title ?? '';
  if (!isSensitive(title)) add(title);
  add(session.agent);
  if (session.model) add(session.model);
  const re = /[A-Za-z_][A-Za-z0-9_./:+#-]{2,47}/g;
  for (const text of recentTexts.slice(-12).reverse()) {
    if (terms.length >= 32) break;
    for (const m of text.matchAll(re)) {
      const tok = m[0];
      const distinctive = /[A-Z]/.test(tok) || /[_/.-]/.test(tok);
      if (distinctive && !isSensitive(tok)) add(tok);
      if (terms.length >= 32) break;
    }
  }
  return {
    fields: {
      ...base(),
      sessionId: session.id,
      session: { title: isSensitive(title) ? '' : title, agent: session.agent, model: session.model ?? null, mode: session.mode ?? 'auto', terms },
    },
    vocabulary: merged(userWords, terms, true),
  };
}

/** A session that doesn't exist yet (the new-session composer). */
export function newSessionContext(agent: string, model: string | undefined, deviceName: string | undefined, userWords: string[], shareConversation: boolean): VoiceContext {
  if (!shareConversation) return { fields: base(), vocabulary: userWords };
  const terms = [agent, model ?? '', deviceName ?? ''].map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 48 && /\p{L}/u.test(t));
  return { fields: { ...base(), session: { agent, model: model ?? null, terms } }, vocabulary: merged(userWords, terms, false) };
}
