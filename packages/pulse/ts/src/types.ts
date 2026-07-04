/**
 * @kraki/pulse — public contract types.
 *
 * This file is the sans-I/O boundary: the {@link Endpoint} core consumes
 * {@link Input}s and emits {@link Effect}s. It performs no I/O of its own.
 * See spec/PROTOCOL.md §3–§4. Nothing here knows anything about the caller's
 * application (no sessions, no message types, no identities).
 */

/** Opaque application payload. Pulse never inspects the bytes. */
export type Payload = Uint8Array;

/** Unsigned 64-bit sequence number, held as bigint. 0 = "nothing yet". */
export type Seq = bigint;

/** Monotonic clock reading in milliseconds. */
export type Millis = number;

/**
 * Effects the core emits for the adapter to carry out. Discriminated on `t`.
 * See spec/PROTOCOL.md §3.
 */
export type Effect =
  /** Send these bytes as ONE message on the current link. */
  | { t: 'transmit'; bytes: Uint8Array }
  /** Hand this payload to the application — in order, exactly once. */
  | { t: 'deliver'; seq: Seq; payload: Payload }
  /** Begin establishing the link (dial). */
  | { t: 'open' }
  /** Tear down the current link (dead/stale). */
  | { t: 'close' }
  /**
   * Inbound history before `fromSeq` is unrecoverable. The application is
   * re-synced at `fromSeq`; it MUST discard assumptions about earlier peer
   * messages. This is the explicit "recovered = false". `peerEpoch` is the
   * peer's current outbound epoch.
   */
  | { t: 'reset-inbound'; fromSeq: Seq; peerEpoch: string }
  /**
   * The peer has confirmed receipt of every outbound message with seq ≤
   * `seqUpTo` (our outbox pruned up to here). Lets the application resolve
   * "delivered" for messages it sent — e.g. clear an optimistic UI, or roll it
   * back on timeout if this never arrives. Purely observational; emitting it
   * changes no protocol behavior.
   */
  | { t: 'acked'; seqUpTo: Seq }
  /**
   * Persist this outbox entry to durable storage (survives a process restart).
   * Emitted only by a durable-supported endpoint, only for durable sends. The
   * adapter writes (seq → payload) to disk. Carries ONLY seq and bytes — never a
   * destination, key, or routing hint (the core has none).
   */
  | { t: 'store'; seq: Seq; payload: Payload }
  /**
   * Durable entries with seq ≤ `seqUpTo` are confirmed delivered (or expired)
   * and may be deleted from durable storage.
   */
  | { t: 'unstore'; seqUpTo: Seq };

/** Tunable parameters. Defaults in spec/PROTOCOL.md §8. */
export interface PulseParams {
  heartbeatIntervalMs: number;
  deadAfterMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  reconnectFactor: number;
}

export const DEFAULT_PARAMS: PulseParams = {
  heartbeatIntervalMs: 15_000,
  deadAfterMs: 30_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  reconnectFactor: 2,
};

/**
 * A durable snapshot of an endpoint's producer+consumer state. An adapter that
 * wants restart-durability persists this and restores it via
 * {@link EndpointOptions.restore} before the first input. See spec §10.
 */
export interface Snapshot {
  epoch: string;
  sendSeq: string; // bigint as decimal string (JSON-safe)
  outboxBase: string;
  outbox: Array<{ seq: string; payloadB64: string; durable?: boolean; sentAt?: number }>;
  recvCursor: string;
  peerEpoch: string;
}

/** Per-endpoint durability capability (advertised at handshake). See spec §8.1. */
export interface DurableConfig {
  /** This endpoint can persist its outbox to disk (survives process restart). */
  supported: boolean;
  /** How long a persisted entry is kept before being abandoned (ms). Only
   *  meaningful when supported. Default: kept indefinitely (0 = no expiry). */
  maxRetentionMs?: number;
}

export interface EndpointOptions {
  /**
   * This endpoint's outbound epoch. Per spec §1.2 the caller supplies a fresh
   * collision-resistant value on cold start, or the preserved value when
   * restoring a snapshot. Required so the core stays pure (no randomness/clock).
   */
  epoch: string;
  /** Partial override of {@link DEFAULT_PARAMS}. */
  params?: Partial<PulseParams>;
  /** Deterministic randomness for jitter, in [0, 1). Defaults to Math.random. */
  random?: () => number;
  /** Restore prior durable state (restart-durability). */
  restore?: Snapshot;
  /** Durability capability. Defaults to { supported: false }. */
  durable?: DurableConfig;
}

export const LinkState = {
  Disconnected: 'disconnected',
  Connected: 'connected',
} as const;
export type LinkState = (typeof LinkState)[keyof typeof LinkState];
