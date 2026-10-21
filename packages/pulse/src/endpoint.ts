/**
 * Endpoint — the sans-I/O core state machine. See spec/PROTOCOL.md §2–§7.
 *
 * Symmetric and full-duplex: every endpoint is simultaneously producer and
 * consumer. Performs NO I/O — inputs in, {@link Effect}s out. Deterministic
 * given the same inputs, clock ticks, and injected `random`.
 */

import {
  DEFAULT_PARAMS,
  type DurableConfig,
  type Effect,
  type EndpointOptions,
  LinkState,
  type Payload,
  type PulseParams,
  type Seq,
  type Snapshot,
} from './types.js';
import { decodeFrame, encodeFrame, type Frame } from './wire.js';

interface OutboxEntry {
  seq: Seq;
  payload: Payload;
  /** Sent with durable:true — persist across restart (only if we support it). */
  durable: boolean;
  /** When first assigned a send time, for retention expiry (ms). */
  sentAt: number;
  /** Send-time coalesce key (spec §12). Entries sharing a key supersede each
   *  other: a later send with the same key drops earlier ones from the outbox.
   *  Mutually exclusive with `durable` (enforced in send()). */
  coalesceKey?: string;
}

// Isomorphic base64 for snapshot payloads (runs in Node AND the browser). The
// core must not depend on Buffer — a browser caller imports this too.
function b64encode(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  // btoa in the browser; Buffer fallback only if btoa is absent (old Node).
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64');
}
function b64decode(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export class Endpoint {
  private readonly params: PulseParams;
  private readonly random: () => number;

  private epoch: string;
  private sendSeq: Seq = 0n;
  private outbox: OutboxEntry[] = [];
  private outboxBase: Seq = 0n; // (lowest retained seq) - 1

  private recvCursor: Seq = 0n;
  private peerEpoch = '';

  /** My durability capability (advertised in my HELLO). */
  private readonly durable: DurableConfig;
  /** Whether the peer advertised it can persist (learned from its HELLO). */
  private peerDurableSupported = false;
  /** Which logical stream this endpoint owns on a shared link (spec §13).
   *  Default 0 = legacy single stream. Carried in every frame's v2 header so a
   *  peer {@link StreamSet} can route it; an independent seq/ack/outbox makes a
   *  bulk stream unable to head-of-line block a live stream. */
  private readonly streamId: number;

  private state: LinkState = LinkState.Disconnected;
  private lastRecvAt = 0;
  private lastSendAt = 0;
  private reconnectAt: number | null = null;
  private attempt = 0;
  /** Peer cursor currently being repaired. Duplicate ACKs for the same cursor
   *  are suppressed until it advances or the bounded retry deadline expires. */
  private repairCursor: Seq | null = null;
  private repairSentAt = 0;
  /** Highest cursor the peer has advertised, and when it last advanced (or
   *  when this connection started). Over one ordered connection a lagging
   *  cursor that keeps advancing means our frames are still in flight on a
   *  slow link — resending them would only multiply congestion. */
  private lastPeerCursor: Seq = -1n;
  private peerProgressAt = 0;
  /** Last-known clock (ms), updated on every timed input. Used to stamp sentAt
   *  on send() which has no `now` of its own. */
  private clock = 0;
  /** Wall-clock ms of the most recent transition to Disconnected, or null
   *  while Connected. Preserved across snapshot/restore so a host GC policy that
   *  keys on "disconnected too long → purge / evict" survives a process restart.
   *  See spec §11.
   *
   *  Seeded at construction (`createdAt`) rather than left null, because an
   *  endpoint starts Disconnected: an endpoint that is created and never
   *  connected — a store-and-forward hub minting one to queue for an offline
   *  peer, or restoring one on boot — has been offline since birth, and a GC
   *  keyed on this must be able to reclaim it. Leaving it null made those
   *  endpoints immortal under the policy the spec itself recommends. */
  private disconnectedAt: number | null = null;

  constructor(opts: EndpointOptions) {
    this.params = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
    this.random = opts.random ?? Math.random;
    this.epoch = opts.epoch;
    this.durable = opts.durable ?? { supported: false };
    this.streamId = opts.streamId ?? 0;
    // An endpoint begins Disconnected, so its offline clock starts now. Hosts
    // that construct with a real clock get accurate ages; the 0 default is
    // still strictly better than null (age is measured from process start, so
    // the endpoint remains collectable).
    this.disconnectedAt = opts.createdAtMs ?? 0;
    if (opts.restore) this.loadSnapshot(opts.restore);
  }

  // ── Inputs ──────────────────────────────────────────────────────────────

  send(
    payload: Payload,
    opts?: { durable?: boolean; coalesceKey?: string },
  ): { seq: Seq; effects: Effect[] } {
    // coalesceKey implies durable=false: "never lose" and "may be dropped" are a
    // semantic contradiction. Fail loud rather than silently pick one (spec §12).
    if (opts?.coalesceKey !== undefined && opts?.durable === true) {
      throw new Error('coalesceKey requires durable=false');
    }
    // Validate key length before any state mutation (encodeFrame will later
    // throw RangeError for keys >255 UTF-8 bytes, but by then the outbox is
    // already mutated and the caller has no seq — the entry is orphaned).
    if (
      opts?.coalesceKey !== undefined &&
      new TextEncoder().encode(opts.coalesceKey).length > 255
    ) {
      throw new Error('coalesceKey exceeds 255 bytes');
    }
    const effects: Effect[] = [];
    // Send-time coalescing (spec §12): drop every existing outbox entry with the
    // same key BEFORE appending the new one. Dropped seqs become gaps the peer
    // skips over via the existing RESET-on-resend path (same as purge*). The new
    // message always gets a fresh seq — dropped seqs are never re-used.
    if (opts?.coalesceKey !== undefined) {
      const key = opts.coalesceKey;
      const droppedSeqs: Seq[] = [];
      this.outbox = this.outbox.filter((e) => {
        if (e.coalesceKey === key) {
          droppedSeqs.push(e.seq);
          return false;
        }
        return true;
      });
      // No unstore: coalesceable entries are never durable (guarded above), so
      // nothing was ever persisted. Emit `purged` for logs/metrics only.
      if (droppedSeqs.length > 0) {
        effects.push({
          t: 'purged',
          droppedSeqs,
          reason: `coalesced:${key}`,
          streamId: this.streamId,
        });
      }
    }
    this.sendSeq += 1n;
    const seq = this.sendSeq;
    // A message is durable only if the app asked AND we can persist. If the app
    // asked but we can't, it degrades to a normal in-memory entry (spec §8.1).
    const durable = opts?.durable === true && this.durable.supported;
    // Outbox entry created BEFORE any transmit (spec §3 ordering rule): the
    // payload is resendable before it is ever entrusted to the wire.
    this.outbox.push({ seq, payload, durable, sentAt: this.clock, coalesceKey: opts?.coalesceKey });
    // Persist to durable storage immediately (before transmit), so it survives a
    // restart even if the socket is down right now. Only seq+bytes — no target.
    if (durable) effects.push({ t: 'store', seq, payload, streamId: this.streamId });
    if (this.state === LinkState.Connected) {
      // The DATA durable bit is set only if the PEER can persist it; otherwise
      // it's pointless on the wire. (Our own `durable` above governs OUR outbox
      // persistence; this bit tells the peer to persist on ITS side if it's the
      // one that will hold the message onward — e.g. a store-and-forward node.)
      const wireDurable = opts?.durable === true && this.peerDurableSupported;
      effects.push(
        this.transmit({
          t: 'data',
          seq,
          ack: this.recvCursor,
          payload,
          durable: wireDurable,
          coalesceKey: opts?.coalesceKey,
        }),
      );
    }
    return { seq, effects };
  }

  onConnected(now: number): Effect[] {
    this.clock = now;
    this.state = LinkState.Connected;
    this.disconnectedAt = null;
    this.attempt = 0;
    this.reconnectAt = null;
    this.repairCursor = null;
    this.peerProgressAt = now;
    if (this.lastPeerCursor < this.outboxBase) this.lastPeerCursor = this.outboxBase;
    this.lastRecvAt = now; // give the fresh link a full dead-window grace
    const effects: Effect[] = [];
    effects.push(
      this.transmit(
        {
          t: 'hello',
          epoch: this.epoch,
          recvEpoch: this.peerEpoch,
          recvCursor: this.recvCursor,
          durableSupported: this.durable.supported,
          maxRetentionMs: BigInt(this.durable.maxRetentionMs ?? 0),
        },
        now,
      ),
    );
    return effects;
  }

  onDisconnected(now: number): Effect[] {
    this.clock = now;
    const wasConnected = this.state === LinkState.Connected;
    this.state = LinkState.Disconnected;
    this.repairCursor = null;
    // Stamp the disconnect time only on a real Connected → Disconnected
    // transition — repeated calls (e.g. from adapter idempotency) must not
    // reset the age a host GC policy is measuring against. Keyed on the prior
    // state, not on `disconnectedAt === null`: the field is now seeded at
    // construction, so a null check would never fire and every disconnect would
    // keep reporting the endpoint's birth time.
    if (wasConnected) this.disconnectedAt = now;
    this.attempt += 1;
    this.reconnectAt = now + this.backoffDelay(this.attempt);
    return [];
  }

  onBytes(bytes: Uint8Array, now: number): Effect[] {
    this.clock = now;
    const frame = decodeFrame(bytes);
    if (frame === null) return []; // malformed ⇒ ignore (spec §5.0)
    return this.onFrame(frame, now);
  }

  /** Handle an already-decoded frame. Public so a {@link StreamSet} (which
   *  demuxes by streamId before dispatching) can feed each per-stream endpoint
   *  its own frames without re-decoding. Sets `lastRecvAt` (any frame is
   *  liveness evidence, spec §6). */
  onFrame(frame: Frame, now: number): Effect[] {
    this.clock = now;
    this.lastRecvAt = now;
    switch (frame.t) {
      case 'hello':
        return this.onHello(frame, now);
      case 'data':
        return this.onData(frame, now);
      case 'ack':
        // An explicit ACK is a consumer signaling its cursor (often a hole).
        // Prune what it has, then resend anything it is missing.
        return this.onPeerCursor(frame.ack, now, true);
      case 'reset':
        return this.onReset(frame);
      case 'heartbeat':
        // An idle heartbeat reveals the consumer's cursor; if it lags our
        // sendSeq (tail-loss), resend the gap. This is what heals a tail lost
        // right before the producer went quiet. A lag that is still shrinking
        // is data in flight on a slow link, not loss (see onPeerCursor).
        return this.onPeerCursor(frame.ack, now, false);
    }
  }

  onTick(now: number): Effect[] {
    this.clock = now;
    const effects: Effect[] = [];
    // Expire durable outbox entries older than our retention window: drop them
    // and tell the adapter to delete them from disk. They will never be resent.
    this.expireDurable(now, effects);
    if (this.state === LinkState.Connected) {
      // A repair batch can itself be lost. Retry it on a bounded timer, but do
      // not let every duplicate ACK synchronously clone the retained suffix.
      if (
        this.repairCursor !== null &&
        this.repairCursor < this.sendSeq &&
        now - this.repairSentAt >= this.params.heartbeatIntervalMs &&
        now - this.peerProgressAt >= this.params.heartbeatIntervalMs
      ) {
        this.repairSentAt = now;
        this.resendWithGapAnnounce(this.repairCursor + 1n, effects, now);
      }
      if (now - this.lastSendAt >= this.params.heartbeatIntervalMs) {
        effects.push(this.transmit({ t: 'heartbeat', ack: this.recvCursor }, now));
      }
      if (now - this.lastRecvAt >= this.params.deadAfterMs) {
        effects.push({ t: 'close' });
      }
    } else if (this.reconnectAt !== null && now >= this.reconnectAt) {
      this.reconnectAt = null;
      effects.push({ t: 'open' });
    }
    return effects;
  }

  /** Drop durable outbox entries past the retention window; emit unstore for
   *  each so the adapter clears disk. Only runs when we have a finite retention
   *  and are the durable-supported side. */
  private expireDurable(now: number, effects: Effect[]): void {
    const ttl = this.durable.maxRetentionMs ?? 0;
    if (!this.durable.supported || ttl <= 0) return;
    const expired = this.outbox.filter((e) => e.durable && now - e.sentAt >= ttl);
    if (expired.length === 0) return;
    // Remove expired entries. unstore floor = highest expired seq that is also
    // contiguous from outboxBase is not required; we emit a precise unstore per
    // the highest expired seq (adapter deletes ≤ that among durable ids it holds).
    const expiredSeqs = new Set(expired.map((e) => e.seq));
    this.outbox = this.outbox.filter((e) => !expiredSeqs.has(e.seq));
    const highest = expired.reduce((m, e) => (e.seq > m ? e.seq : m), 0n);
    effects.push({ t: 'unstore', seqUpTo: highest, streamId: this.streamId });
  }

  // ── Frame handlers ────────────────────────────────────────────────────────

  private onHello(f: Extract<Frame, { t: 'hello' }>, now: number): Effect[] {
    const effects: Effect[] = [];
    // Detect peer cold-restart (RESTART-FRESH, spec §9): the peer previously
    // used a different epoch, now advertises a new one. All state we hold about
    // the peer's send-side (recvCursor, expected-next-seq) refers to a stream
    // that no longer exists. If we don't drop it, the peer's fresh seq=1..N
    // frames will be silently dropped by the duplicate-check in onData
    // (`f.seq <= recvCursor`). Surface the discontinuity so the app learns
    // history was dropped, then accept the peer's new stream from seq=1.
    if (this.peerEpoch !== '' && f.epoch !== this.peerEpoch) {
      this.recvCursor = 0n;
      effects.push({ t: 'reset-inbound', fromSeq: 1n, peerEpoch: f.epoch });
    }
    this.peerEpoch = f.epoch;
    // Learn whether the peer can persist — governs the wire durable bit we set.
    this.peerDurableSupported = f.durableSupported;

    // (a) Peer resuming against an epoch we no longer have (we cold-started).
    if (f.recvEpoch !== '' && f.recvEpoch !== this.epoch) {
      this.resetPeerToFirstDeliverable(effects, now);
      return effects;
    }

    // (b) Prune what the peer already has, then resend the rest — announcing any
    // gap at the head of our outbox (e.g. a non-durable entry lost in a restart).
    if (f.recvCursor >= this.outboxBase) {
      this.pruneOutbox(f.recvCursor, effects);
      this.resendWithGapAnnounce(f.recvCursor + 1n, effects, now);
    } else {
      // Peer is behind our oldest retained seq — we pruned what it needs.
      this.resetPeerToFirstDeliverable(effects, now);
    }
    return effects;
  }

  /**
   * Tell the peer where our stream continues, then resend from there.
   *
   * `oldest` must be a seq we can actually deliver: the oldest retained entry,
   * or — nothing retained — the next seq we will send. Announcing
   * `outboxBase + 1` instead is wrong whenever entries above the base were
   * dropped: after a restart from a durable-only snapshot (non-durable sends
   * since the snapshot are gone, so `sendSeq` is ahead of the base) or after a
   * purge. The peer then waits for a seq that will never come, holds every
   * later frame as a hole, and — once a stale piggybacked ack from its previous
   * connection has advanced our base past its new cursor — its repair ACKs are
   * ignored as stale. A relay restart left a computer deaf to all relay
   * control this way (kraki 2026-10-21).
   */
  private resetPeerToFirstDeliverable(effects: Effect[], now: number): void {
    let oldest = this.sendSeq + 1n;
    for (const e of this.outbox) if (e.seq < oldest) oldest = e.seq;
    effects.push(this.transmit({ t: 'reset', epoch: this.epoch, oldest }, now));
    this.resendFrom(oldest, effects, now);
  }

  private onData(f: Extract<Frame, { t: 'data' }>, now: number): Effect[] {
    const effects: Effect[] = [];
    this.pruneOutbox(f.ack, effects); // peer piggybacks its receipt of our outbound
    if (f.seq === this.recvCursor + 1n) {
      this.recvCursor = f.seq;
      effects.push({
        t: 'deliver',
        seq: f.seq,
        payload: f.payload,
        durable: f.durable,
        coalesceKey: f.coalesceKey,
        streamId: this.streamId,
      });
    } else if (f.seq <= this.recvCursor) {
      // Duplicate (a resend because our earlier ack was lost). Re-advertise our
      // cursor so the sender learns we already have it and stops resending —
      // without this, a lost ack can wedge the sender resending forever and it
      // never observes delivery. (Same rationale as TCP's dup-ACK.)
      effects.push(this.transmit({ t: 'ack', ack: this.recvCursor }, now));
    } else {
      // hole: seq > recvCursor+1. Do not deliver; ask peer to rewind.
      effects.push(this.transmit({ t: 'ack', ack: this.recvCursor }, now));
    }
    return effects;
  }

  /**
   * A peer advertised its receive cursor (via explicit ACK or idle HEARTBEAT).
   * Prune what it confirms, and if it is behind our latest send, resend the gap
   * so tail-loss and holes self-heal without a reconnect.
   */
  private onPeerCursor(peerCursor: Seq, now: number, explicitAck: boolean): Effect[] {
    const effects: Effect[] = [];
    // ACKs are cumulative. Once a higher cursor has been observed and pruned,
    // an older ACK can only be stale/in-flight; it must never rewind recovery.
    if (peerCursor < this.outboxBase) return effects;
    if (peerCursor > this.lastPeerCursor) {
      this.lastPeerCursor = peerCursor;
      this.peerProgressAt = now;
    }
    this.pruneOutbox(peerCursor, effects);
    if (peerCursor >= this.sendSeq) {
      this.repairCursor = null;
      return effects;
    }
    // A burst behind one missing DATA can queue many identical ACKs before the
    // first repair crosses the wire. Emit one bounded repair batch for that
    // cursor; onTick retries it if the batch itself is lost.
    if (this.repairCursor === peerCursor) return effects;
    this.repairCursor = peerCursor;
    // An explicit ACK is the peer reporting a duplicate or a hole: act now.
    // A heartbeat merely advertises progress. If that cursor advanced within
    // the last heartbeat interval it is behind only because our frames are
    // still queued on a slow link: repair once it stops advancing (onTick),
    // never while the peer is catching up.
    if (!explicitAck && now - this.peerProgressAt < this.params.heartbeatIntervalMs) {
      this.repairSentAt = this.peerProgressAt;
      return effects;
    }
    this.repairSentAt = now;
    this.resendWithGapAnnounce(peerCursor + 1n, effects, now);
    return effects;
  }

  /** Resend outbox entries from `fromSeq`, announcing (via RESET) any gap the
   *  resend itself cannot close.
   *
   *  `resendFrom` injects a RESET before every entry that isn't contiguous with
   *  the previous one, which covers gaps at the head and in the middle. It
   *  cannot cover a gap at the TAIL: those RESETs are driven by a following
   *  entry, so when the dropped seqs are the highest ones we hold (the outbox
   *  ends up empty, or its max seq is below `sendSeq`) the loop never runs and
   *  the peer is never told. It then holds the gap open, keeps re-ACKing its old
   *  cursor, and only a LATER unrelated send drags it forward — one full repair
   *  round-trip late, or indefinitely on an otherwise idle stream.
   *
   *  A tail gap is exactly what a host GC produces: `purgeNonDurable` drops the
   *  queued tail of an offline peer's outbox (spec §11.4). */
  private resendWithGapAnnounce(fromSeq: Seq, effects: Effect[], now: number): void {
    this.resendFrom(fromSeq, effects, now);
    // Highest seq we can still deliver from `fromSeq` onward.
    let highestRetained: Seq | null = null;
    for (const e of this.outbox) {
      if (e.seq >= fromSeq && (highestRetained === null || e.seq > highestRetained)) {
        highestRetained = e.seq;
      }
    }
    // Everything above it, up to sendSeq, is gone for good. Announce the skip so
    // the peer's recvCursor clears the hole instead of waiting for a fill that
    // can never arrive.
    const tailGapFrom = highestRetained === null ? fromSeq : highestRetained + 1n;
    if (tailGapFrom <= this.sendSeq) {
      effects.push(
        this.transmit({ t: 'reset', epoch: this.epoch, oldest: this.sendSeq + 1n }, now),
      );
    }
  }

  private onReset(f: Extract<Frame, { t: 'reset' }>): Effect[] {
    // A RESET naming an epoch we have not seen starts a new send stream (the
    // peer restarted). Our cursor refers to the old stream, so it is replaced,
    // not merely raised: a cursor left above `oldest` would drop the new
    // stream's frames as duplicates. Normally the peer's HELLO arrives first
    // and has already zeroed it; this covers a RESET that wins the race.
    if (f.epoch !== this.peerEpoch && f.oldest > 0n) {
      this.peerEpoch = f.epoch;
      this.recvCursor = f.oldest - 1n;
      return [{ t: 'reset-inbound', fromSeq: f.oldest, peerEpoch: f.epoch }];
    }
    this.peerEpoch = f.epoch;
    if (f.oldest > this.recvCursor + 1n) {
      // Unavoidable gap: (recvCursor+1 .. oldest-1) are gone forever.
      this.recvCursor = f.oldest - 1n;
      return [{ t: 'reset-inbound', fromSeq: f.oldest, peerEpoch: f.epoch }];
    }
    // else: no gap; peer will resend from recvCursor+1 as usual.
    return [];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private resendFrom(fromSeq: Seq, effects: Effect[], now: number): void {
    // outbox may be SPARSE after purge / snapshotDurable restore (host GC
    // dropped some seqs mid-stream). Walk entries in seq order and inject a
    // RESET before any seq that isn't contiguous with the last one we sent —
    // it advances the peer's recvCursor over the gap so the following DATA
    // frame delivers. Without this the peer holds the gap open, ACKs its old
    // cursor, and we live-lock.
    const entries = this.outbox
      .filter((e) => e.seq >= fromSeq)
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    let expectedNext = fromSeq;
    for (const e of entries) {
      if (e.seq > expectedNext) {
        // Missing seqs [expectedNext .. e.seq-1] — inform peer to skip them.
        effects.push(this.transmit({ t: 'reset', epoch: this.epoch, oldest: e.seq }, now));
      }
      const wireDurable = e.durable && this.peerDurableSupported;
      effects.push(
        this.transmit(
          {
            t: 'data',
            seq: e.seq,
            ack: this.recvCursor,
            payload: e.payload,
            durable: wireDurable,
            coalesceKey: e.coalesceKey,
          },
          now,
        ),
      );
      expectedNext = e.seq + 1n;
    }
  }

  private pruneOutbox(ackSeq: Seq, effects?: Effect[]): void {
    if (ackSeq <= this.outboxBase) return;
    // Clamp to sendSeq: the peer's recvCursor can exceed our sendSeq after we
    // restart from a durable-only snapshot (non-durable sends are lost, so
    // sendSeq was rewound, but the peer kept running and acks a higher seq).
    // Without this clamp, outboxBase races ahead of sendSeq, and on the NEXT
    // reconnect the peer (recvCursor=0) sees its fresh seq=1..N as "duplicates"
    // (≤ outboxBase) and silently drops them — permanently wedging the link.
    // This was the root cause of the 2026-07-10 kraki prod outage.
    const clamped = ackSeq > this.sendSeq ? this.sendSeq : ackSeq;
    if (clamped <= this.outboxBase) return;
    // Any durable entries being pruned are now confirmed delivered — tell the
    // adapter it may delete them from disk.
    const hadDurable = this.outbox.some((e) => e.seq <= clamped && e.durable);
    this.outbox = this.outbox.filter((e) => e.seq > clamped);
    this.outboxBase = clamped;
    if (this.repairCursor !== null && clamped > this.repairCursor) {
      this.repairCursor = null;
    }
    // Surface the confirmed delivery floor so the app can resolve/roll back
    // optimistic UI for messages it sent. Observational only.
    effects?.push({ t: 'acked', seqUpTo: clamped, streamId: this.streamId });
    if (hadDurable) effects?.push({ t: 'unstore', seqUpTo: clamped, streamId: this.streamId });
  }

  /** Build a transmit effect and mark send activity. `now` optional for the
   *  data-send path where lastSendAt is refreshed by the caller context. The
   *  bytes carry this endpoint's streamId in the v2 header. */
  private transmit(frame: Frame, now?: number): Effect {
    if (now !== undefined) this.lastSendAt = now;
    return { t: 'transmit', bytes: encodeFrame(frame, this.streamId) };
  }

  private backoffDelay(attempt: number): number {
    const ceil = Math.min(
      this.params.reconnectMaxMs,
      this.params.reconnectBaseMs * this.params.reconnectFactor ** (attempt - 1),
    );
    return Math.floor(this.random() * (ceil + 1)); // full jitter: uniform [0, ceil]
  }

  // ── Observation ────────────────────────────────────────────────────────────

  nextDeadline(): number | null {
    if (this.state === LinkState.Connected) {
      // Earliest of: next heartbeat due, next dead-check due.
      return Math.min(
        this.lastSendAt + this.params.heartbeatIntervalMs,
        this.lastRecvAt + this.params.deadAfterMs,
        this.repairCursor === null
          ? Number.POSITIVE_INFINITY
          : Math.max(this.repairSentAt, this.peerProgressAt) + this.params.heartbeatIntervalMs,
      );
    }
    return this.reconnectAt;
  }

  get link(): LinkState {
    return this.state;
  }
  /** The logical stream this endpoint owns on a shared link (spec §13). */
  get stream(): number {
    return this.streamId;
  }
  get sendSeqValue(): Seq {
    return this.sendSeq;
  }
  get recvCursorValue(): Seq {
    return this.recvCursor;
  }
  get outboxSize(): number {
    return this.outbox.length;
  }
  /** Cumulative bytes of payload currently in the outbox — for host memory
   *  accounting / GC decisions. Does not include per-entry overhead (seq etc.).
   *  See spec §11. */
  get outboxByteSize(): number {
    let n = 0;
    for (const e of this.outbox) n += e.payload.byteLength;
    return n;
  }
  /** Count of durable-flagged entries in the outbox. */
  get durableCount(): number {
    let n = 0;
    for (const e of this.outbox) if (e.durable) n += 1;
    return n;
  }
  /** Count of non-durable entries in the outbox. */
  get nonDurableCount(): number {
    let n = 0;
    for (const e of this.outbox) if (!e.durable) n += 1;
    return n;
  }
  /** The clock reading (host ms) when the OLDEST outbox entry was first sent.
   *  Null if the outbox is empty. Lets a host GC "entries older than N ms". */
  get oldestSentAt(): number | null {
    let min: number | null = null;
    for (const e of this.outbox) {
      if (min === null || e.sentAt < min) min = e.sentAt;
    }
    return min;
  }
  /** Wall-clock ms since when this endpoint has been offline, or null while
   *  Connected. Set on each Connected → Disconnected transition, and seeded at
   *  construction (see {@link EndpointOptions.createdAtMs}) so an endpoint that
   *  was never connected — minted to queue for an offline peer, or restored on
   *  boot — still reports a finite age. Preserved across snapshot/restore. Lets
   *  a host policy key on "endpoint has been down for N minutes → purge outbox /
   *  evict endpoint entirely". See spec §11. */
  get disconnectedAtMs(): number | null {
    return this.disconnectedAt;
  }

  /**
   * Remove outbox entries matching `predicate`. Returns the seqs dropped and
   * any effects the removal produced (an `unstore` for any durable rows the
   * adapter should now delete from disk, plus an observational `purged`).
   *
   * This is the host's escape-hatch for GC: after a long disconnect it may
   * decide that queued non-durable frames are stale ("nobody would want the
   * animation frame from 10 minutes ago"), or that even durable entries have
   * passed a domain-specific relevance window. The effects the peer sees on
   * next resend are the same as if those seqs had been individually acked.
   *
   * See spec §11.
   */
  purge(
    predicate: (e: { seq: Seq; durable: boolean; sentAt: number; byteLength: number }) => boolean,
    reason = 'host',
  ): { droppedSeqs: Seq[]; effects: Effect[] } {
    const droppedSeqs: Seq[] = [];
    let hadDurable = false;
    let maxDroppedDurableSeq: Seq = 0n;
    const kept: OutboxEntry[] = [];
    for (const e of this.outbox) {
      if (
        predicate({
          seq: e.seq,
          durable: e.durable,
          sentAt: e.sentAt,
          byteLength: e.payload.byteLength,
        })
      ) {
        droppedSeqs.push(e.seq);
        if (e.durable) {
          hadDurable = true;
          if (e.seq > maxDroppedDurableSeq) maxDroppedDurableSeq = e.seq;
        }
      } else {
        kept.push(e);
      }
    }
    this.outbox = kept;
    const effects: Effect[] = [];
    // Tell the adapter to delete any durable rows the purge just dropped.
    // We emit a coarse unstore(seqUpTo=maxDroppedDurableSeq); the adapter
    // only deletes durable rows it holds ≤ that seq, so leftover durable
    // entries > that seq are untouched.
    if (hadDurable)
      effects.push({ t: 'unstore', seqUpTo: maxDroppedDurableSeq, streamId: this.streamId });
    if (droppedSeqs.length > 0)
      effects.push({ t: 'purged', droppedSeqs, reason, streamId: this.streamId });
    return { droppedSeqs, effects };
  }

  /** Convenience: drop all non-durable outbox entries. The common case for
   *  the host GC (see spec §11 non-durable retention). */
  purgeNonDurable(reason = 'gc'): { droppedSeqs: Seq[]; effects: Effect[] } {
    return this.purge((e) => !e.durable, reason);
  }

  /**
   * Snapshot the endpoint's state including ALL outbox entries (durable +
   * non-durable). Preserves the pre-0.2.0 behavior; keeps existing hosts
   * working unchanged. Use {@link snapshotDurable} for the spec-correct
   * "durable-only" form when persisting across process restart.
   */
  snapshot(): Snapshot {
    return this.snapshotInternal((_e) => true);
  }

  /**
   * Snapshot ONLY the durable outbox entries. This is the spec-correct form to
   * persist across process restart: non-durable entries are, by definition,
   * "in-memory only, may be lost on restart" (spec §8.1). Preserving them
   * across restart both violates that contract AND causes unbounded memory
   * growth if the host writes snapshots aggressively (each save duplicates
   * the same in-memory outbox into a growing on-disk state).
   *
   * On restore from a durable-only snapshot, the outbox may be sparse in seq
   * space. The core handles that transparently: `resendFrom` walks entries
   * in seq order and emits a RESET frame before any gap, so the peer skips
   * the lost non-durable seqs.
   */
  snapshotDurable(): Snapshot {
    return this.snapshotInternal((e) => e.durable);
  }

  private snapshotInternal(filter: (e: OutboxEntry) => boolean): Snapshot {
    return {
      epoch: this.epoch,
      sendSeq: this.sendSeq.toString(),
      outboxBase: this.outboxBase.toString(),
      outbox: this.outbox.filter(filter).map((e) => ({
        seq: e.seq.toString(),
        payloadB64: b64encode(e.payload),
        durable: e.durable,
        sentAt: e.sentAt,
        coalesceKey: e.coalesceKey,
      })),
      recvCursor: this.recvCursor.toString(),
      peerEpoch: this.peerEpoch,
      disconnectedAtMs: this.disconnectedAt,
    };
  }

  private loadSnapshot(s: Snapshot): void {
    // NOTE: `this.epoch` is intentionally NOT restored from the snapshot.
    // The epoch identifies a SEND STREAM's identity (spec §9). A process
    // restart is, by definition, a new stream: the durable outbox entries
    // we restore will be resent under our current (fresh) epoch, and any
    // non-durable sends that were in flight are lost — the peer MUST learn
    // this discontinuity so it resets its recvCursor and accepts the new
    // stream from its resumed seqs, instead of treating our post-restart
    // seq=1..N as duplicates of the pre-crash seq=1..N it already delivered
    // (the 2026-07-11 kraki relay-restart device_joined-loss bug). Restoring
    // the old epoch would make the restart look transparent to the peer,
    // but a non-durable send-gap is NOT transparent — so the epoch must
    // roll forward. Keep `opts.epoch` (the freshly-generated value).
    this.sendSeq = BigInt(s.sendSeq);
    this.outboxBase = BigInt(s.outboxBase);
    // Defensive clamp: a snapshot persisted by a pre-0.3.1 version could have
    // outboxBase > sendSeq (the bug fixed in pruneOutbox above — the peer's
    // recvCursor raced ahead of our sendSeq after a restart). Loading that
    // verbatim would re-introduce the wedge on the next reconnect. Clamp here
    // so corrupted snapshots self-heal on load.
    if (this.outboxBase > this.sendSeq) this.outboxBase = this.sendSeq;
    this.outbox = s.outbox.map((e) => ({
      seq: BigInt(e.seq),
      payload: b64decode(e.payloadB64),
      durable: e.durable ?? false,
      sentAt: e.sentAt ?? 0,
      coalesceKey: e.coalesceKey,
    }));
    this.recvCursor = BigInt(s.recvCursor);
    this.peerEpoch = s.peerEpoch;
    // A snapshot taken while Connected carries null. The restored endpoint is
    // Disconnected (it has no link yet), so keep the constructor's seed instead
    // of adopting null — otherwise every endpoint restored on boot reports "never
    // disconnected" and the §11.4 GC can never reclaim it.
    if (s.disconnectedAtMs !== undefined && s.disconnectedAtMs !== null) {
      this.disconnectedAt = s.disconnectedAtMs;
    }
  }
}
