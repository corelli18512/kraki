// ============================================================
// Payload fragments — large Pulse payloads split into small parts
// ============================================================
//
// A Pulse payload is delivered as one WebSocket message. On a slow link a
// multi-hundred-KB payload (history batch, long reply, image input) takes
// longer than any client can wait without evidence of progress, and native
// clients cannot observe partial frames, so the link looks dead and is
// replaced — forever, for a message that never fits.
//
// Peers that both support it send such payloads as ordered fragments: every
// part is its own small Pulse message, so progress is visible and liveness
// checks (pong or payload delivery) keep succeeding. The Relay forwards them
// opaquely; only the two ends know about fragments.
//
// Negotiation: a Tentacle advertises `fragments` in `device_greeting.features`;
// an app that can reassemble replies with `client_features`. Neither side
// sends fragments to a peer that has not advertised support.

export const PAYLOAD_FRAGMENT_FEATURE = 'fragments';
/** Payloads larger than this are fragmented (when the peer supports it). */
export const PAYLOAD_FRAGMENT_THRESHOLD = 64 * 1024;
/** Characters of the original payload per fragment. */
export const PAYLOAD_FRAGMENT_SIZE = 32 * 1024;

export interface PayloadFragment {
  kfrag: 1;
  /** Unique per fragmented payload. */
  id: string;
  /** Index of this part, 0-based. */
  i: number;
  /** Total number of parts. */
  n: number;
  /** This part of the original payload string. */
  d: string;
}

const ASCII = /^[\x00-\x7f]*$/;

/**
 * Split `payload` into fragment payload strings, or return null when it is
 * small enough to send whole. Only ASCII payloads are split (encrypted
 * `{blob, keys}` payloads always are), so parts never cut a character.
 */
export function fragmentPayload(
  payload: string,
  id: string,
  size = PAYLOAD_FRAGMENT_SIZE,
  threshold = PAYLOAD_FRAGMENT_THRESHOLD,
): string[] | null {
  if (payload.length <= threshold || !ASCII.test(payload)) return null;
  const n = Math.ceil(payload.length / size);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const fragment: PayloadFragment = { kfrag: 1, id, i, n, d: payload.slice(i * size, (i + 1) * size) };
    parts.push(JSON.stringify(fragment));
  }
  return parts;
}

export function isPayloadFragment(value: unknown): value is PayloadFragment {
  const f = value as Partial<PayloadFragment> | null;
  return !!f && f.kfrag === 1 && typeof f.id === 'string' && Number.isInteger(f.i) && Number.isInteger(f.n)
    && typeof f.d === 'string' && (f.n as number) > 0 && (f.i as number) >= 0 && (f.i as number) < (f.n as number);
}

/**
 * Reassembles fragments (any interleaving across ids). Memory is bounded:
 * the oldest incomplete payloads are dropped beyond `maxBytes`, and payloads
 * untouched for `ttlMs` are discarded. A dropped payload never surfaces; the
 * sender's higher layers (echo/confirmation, re-requests) recover it.
 */
export class PayloadAssembler {
  private sets = new Map<string, { parts: Array<string | undefined>; got: number; bytes: number; touched: number }>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 48 * 1024 * 1024,
    private readonly maxParts = 4096,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the whole payload when `fragment` completes it, else null. */
  accept(fragment: PayloadFragment): string | null {
    if (fragment.n > this.maxParts) return null;
    const now = this.now();
    for (const [id, set] of this.sets) {
      if (now - set.touched > this.ttlMs) this.drop(id);
    }
    let set = this.sets.get(fragment.id);
    if (!set) {
      set = { parts: new Array(fragment.n), got: 0, bytes: 0, touched: now };
      this.sets.set(fragment.id, set);
    }
    if (set.parts.length !== fragment.n) return null; // inconsistent: ignore
    set.touched = now;
    if (set.parts[fragment.i] === undefined) {
      set.parts[fragment.i] = fragment.d;
      set.got += 1;
      set.bytes += fragment.d.length;
      this.bytes += fragment.d.length;
    }
    if (set.got === fragment.n) {
      this.drop(fragment.id);
      return set.parts.join('');
    }
    for (const id of this.sets.keys()) {
      if (this.bytes <= this.maxBytes) break;
      if (id !== fragment.id) this.drop(id);
    }
    return null;
  }

  /** Forget everything (e.g. the peer restarted and resent nothing). */
  clear(): void {
    this.sets.clear();
    this.bytes = 0;
  }

  get pendingPayloads(): number { return this.sets.size; }

  private drop(id: string): void {
    const set = this.sets.get(id);
    if (!set) return;
    this.bytes -= set.bytes;
    this.sets.delete(id);
  }
}
