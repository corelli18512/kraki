/**
 * Outbox — optimistic user input with delivery states (port of the iOS/Mac
 * `CommandSender` outbox).
 *
 * A sent message shows at once as the user's own bubble (`sending`). The
 * Tentacle echo (`user_message` carrying the same `clientId`) confirms it and
 * the entry disappears as the real bubble lands. It becomes `failed`
 * (Retry / Delete) only after 30 s of *stalled* time, accumulated in steps:
 * relay connected and live, device online, and no payload arriving. Time on a
 * dead, reconnecting or busy link never counts: unconfirmed is not failed.
 * Halfway through, a Tentacle that deduplicates gets it once more (same
 * clientId), like the native apps.
 *
 * Entries survive a reload. Whether they reached the Tentacle is unknown, so
 * they wait (`needsResend`) until the session's Tentacle greets: one that
 * deduplicates by clientId (`idempotent_input`) gets them again
 * automatically; an older one would run a duplicate, so they are marked
 * `failed` for the user to decide.
 */
import { create } from 'zustand';
import type { Attachment } from '@kraki/protocol';

export type PendingState = 'sending' | 'failed';

export interface PendingInput {
  clientId: string;
  sessionId: string;
  text: string;
  attachments?: Attachment[];
  /** Steer the running turn (never set together with `answerTo`). */
  delivery?: 'steer';
  /** The question this input answers. */
  answerTo?: string;
  timestamp: string;
  order: number;
  state: PendingState;
  /** Unknown fate: send again once the Tentacle is known to deduplicate. */
  needsResend?: boolean;
}

interface OutboxDeps {
  /** Hand a consumer message to transport; resolves false when it could not
   *  be sent (no key / no target). */
  send: (msg: Record<string, unknown>) => Promise<boolean>;
  /** Relay connected and live, and the session's device online. */
  isDeliveryPathUp: (sessionId: string) => boolean;
  /** The session's Tentacle deduplicates inputs (`undefined`: not known yet). */
  acceptsResend?: (sessionId: string) => boolean | undefined;
}

const STORAGE_KEY = 'kraki-outbox-v1';
/** Attachments above this size are kept in memory only. */
const PERSIST_ATTACHMENT_LIMIT = 1_000_000;

let deps: OutboxDeps | null = null;
let confirmationTimeoutMs = 30_000;
/** A tick never counts more than this: background tabs throttle timers to
 *  about one a minute, and that minute was not observed as stalled. */
const MAX_STEP_MS = 2_000;
/** Stalled time so far per transmitted, unconfirmed input. */
const stalls = new Map<string, { stalledMs: number; resent: boolean }>();
let lastTickAt: number | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

interface OutboxState {
  entries: PendingInput[];
}

export const useOutbox = create<OutboxState>(() => ({ entries: restore() }));

function restore(): PendingInput[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const stored = JSON.parse(raw) as PendingInput[];
    if (!Array.isArray(stored)) return [];
    const restored = stored.map((e) => (e.state === 'failed' ? e : { ...e, state: 'sending' as const, needsResend: true }));
    if (restored.some((e) => e.needsResend)) ensureTicker();
    return restored;
  } catch {
    return [];
  }
}

function persist(entries: PendingInput[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (entries.length === 0) { localStorage.removeItem(STORAGE_KEY); return; }
    const slim = entries.map((e) => {
      const size = (e.attachments ?? []).reduce((n, a) => n + (a.type === 'image' ? a.data.length : 0), 0);
      return size > PERSIST_ATTACHMENT_LIMIT ? { ...e, attachments: undefined } : e;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    // Quota exceeded: the in-memory outbox still works for this page.
  }
}

function update(fn: (entries: PendingInput[]) => PendingInput[]): void {
  const next = fn(useOutbox.getState().entries);
  useOutbox.setState({ entries: next });
  persist(next);
}

function setState(clientId: string, state: PendingState): void {
  update((entries) => entries.map((e) => (e.clientId === clientId && e.state !== state ? { ...e, state } : e)));
}

function wirePayload(entry: PendingInput): Record<string, unknown> {
  return {
    text: entry.text,
    clientId: entry.clientId,
    ...(entry.attachments?.length && { attachments: entry.attachments }),
    ...(entry.answerTo ? { answerTo: entry.answerTo } : entry.delivery === 'steer' ? { delivery: 'steer' } : {}),
  };
}

function ensureTicker(): void {
  if (ticker || typeof setInterval === 'undefined') return;
  ticker = setInterval(checkDeadlines, 1_000);
}

/** One confirmation tick (every second). The echo is the confirmation; only
 *  stalled time counts toward failure (see `OutboxDeps.isDeliveryPathUp`). */
export function checkDeadlines(now = Date.now()): void {
  const step = lastTickAt === null ? 0 : Math.max(0, Math.min(now - lastTickAt, MAX_STEP_MS));
  lastTickAt = now;
  for (const entry of useOutbox.getState().entries) {
    if (entry.state !== 'sending') continue;
    if (entry.needsResend) {
      if (!deps?.isDeliveryPathUp(entry.sessionId)) continue;
      const accepts = deps.acceptsResend?.(entry.sessionId);
      if (accepts === undefined) continue;
      if (accepts) {
        transmit(clearResend(entry));
      } else {
        clearResend(entry);
        setState(entry.clientId, 'failed');
      }
      continue;
    }
    const stall = stalls.get(entry.clientId);
    if (!stall || !deps?.isDeliveryPathUp(entry.sessionId)) continue;
    stall.stalledMs += step;
    if (!stall.resent && stall.stalledMs >= confirmationTimeoutMs / 2 && deps.acceptsResend?.(entry.sessionId) === true) {
      // Maybe lost on the way (e.g. a socket that died with it): offer it
      // once more; the Tentacle drops a duplicate by clientId.
      stall.resent = true;
      void deps.send({ type: 'send_input', sessionId: entry.sessionId, payload: wirePayload(entry) });
    }
    if (stall.stalledMs >= confirmationTimeoutMs) {
      stalls.delete(entry.clientId);
      setState(entry.clientId, 'failed');
    }
  }
}

function clearResend(entry: PendingInput): PendingInput {
  update((entries) => entries.map((e) => (e.clientId === entry.clientId ? { ...e, needsResend: undefined } : e)));
  return { ...entry, needsResend: undefined };
}

function transmit(entry: PendingInput): void {
  stalls.set(entry.clientId, { stalledMs: 0, resent: false });
  lastTickAt ??= Date.now();
  ensureTicker();
  const send = deps?.send;
  if (!send) { setState(entry.clientId, 'failed'); return; }
  void send({ type: 'send_input', sessionId: entry.sessionId, payload: wirePayload(entry) }).then((ok) => {
    if (!ok) { stalls.delete(entry.clientId); setState(entry.clientId, 'failed'); }
  });
}

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const outbox = {
  configure(next: OutboxDeps): void {
    deps = next;
  },

  /** Test hook. */
  setConfirmationTimeout(ms: number): void {
    confirmationTimeoutMs = ms;
  },

  /** Send a message (optimistic bubble + transport). Returns its clientId. */
  send(sessionId: string, text: string, opts: { attachments?: Attachment[]; delivery?: 'prompt' | 'steer'; answerTo?: string } = {}): string {
    const entries = useOutbox.getState().entries;
    const entry: PendingInput = {
      clientId: newClientId(),
      sessionId,
      text,
      ...(opts.attachments?.length && { attachments: opts.attachments }),
      // An answer is its own message, never a steer of the running turn.
      ...(opts.answerTo ? { answerTo: opts.answerTo } : opts.delivery === 'steer' ? { delivery: 'steer' as const } : {}),
      timestamp: new Date().toISOString(),
      order: entries.reduce((n, e) => Math.max(n, e.order), 0) + 1,
      state: 'sending',
    };
    update((list) => [...list, entry]);
    transmit(entry);
    return entry.clientId;
  },

  /** Resend with the SAME clientId (idempotent on the Tentacle side). */
  retry(clientId: string): void {
    const entry = useOutbox.getState().entries.find((e) => e.clientId === clientId);
    if (!entry) return;
    setState(clientId, 'sending');
    transmit({ ...entry, state: 'sending' });
  },

  /** The Tentacle (re)greeted: inputs it has not echoed may be lost. If it
   *  deduplicates, offer every unconfirmed one matching `inSession` again.
   *  An older Tentacle is left alone: those inputs keep waiting for their
   *  echo (the normal confirmation timeout applies). */
  resendUnconfirmed(inSession: (sessionId: string) => boolean): void {
    const eligible = (e: PendingInput) => e.state === 'sending' && inSession(e.sessionId)
      && deps?.acceptsResend?.(e.sessionId) === true;
    if (!useOutbox.getState().entries.some(eligible)) return;
    update((entries) => entries.map((e) => (eligible(e) ? { ...e, needsResend: true } : e)));
    ensureTicker();
    checkDeadlines();
  },

  /** Remove an unconfirmed input (Delete). Returns its text. */
  discard(clientId: string): string | undefined {
    const entry = useOutbox.getState().entries.find((e) => e.clientId === clientId);
    stalls.delete(clientId);
    update((list) => list.filter((e) => e.clientId !== clientId));
    return entry?.text;
  },

  /** The Tentacle echo landed. Without a clientId (older Tentacles) the first
   *  entry with the same text in the session is taken. Returns true when an
   *  entry was confirmed. */
  confirm(sessionId: string, clientId: string | undefined, content: string | undefined): boolean {
    const entries = useOutbox.getState().entries;
    const match = clientId
      ? entries.find((e) => e.clientId === clientId)
      : content !== undefined
        ? entries.find((e) => e.sessionId === sessionId && e.text === content)
        : undefined;
    if (!match) return false;
    stalls.delete(match.clientId);
    update((list) => list.filter((e) => e.clientId !== match.clientId));
    return true;
  },

  forSession(sessionId: string): PendingInput[] {
    return useOutbox.getState().entries.filter((e) => e.sessionId === sessionId).sort((a, b) => a.order - b.order);
  },

  /** Drop a deleted session's entries. */
  clearSession(sessionId: string): void {
    update((list) => list.filter((e) => e.sessionId !== sessionId));
  },

  /** Test hook: re-read storage as a page reload would. */
  reloadForTesting(): void {
    stalls.clear();
    lastTickAt = null;
    useOutbox.setState({ entries: restore() });
  },

  /** Test hook: forget everything. */
  reset(): void {
    stalls.clear();
    lastTickAt = null;
    useOutbox.setState({ entries: [] });
    persist([]);
  },
};
