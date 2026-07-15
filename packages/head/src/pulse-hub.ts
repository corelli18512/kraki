/**
 * PulseHub — head as a per-hop pulse endpoint hub.
 *
 * pulse is a reliable-WebSocket-replacement layer. Under the per-hop model the
 * relay is a pulse endpoint on *each* connection: every connected device gets
 * its own {@link Endpoint} here. When a device sends a pulse-framed envelope,
 * the hub feeds the frame to that device's endpoint and carries out the effects:
 *
 *   - `deliver`  → the reliable app payload arrived from this device; forward it
 *                  onto the DESTINATION device's endpoint (store-and-forward
 *                  bridge). Routing (which device) is the hub's job, not pulse's.
 *   - `store` / `unstore` → persist / delete the outbox entry in SQLite, so a
 *                  durable message survives the destination being offline AND a
 *                  restart of head itself.
 *   - `transmit` → send control/resend bytes back to the SOURCE device.
 *
 * The hub reads only the pulse frame header (seq/ack/durable) — the frame's
 * payload segment is the opaque E2E ciphertext, never decrypted here.
 *
 * Only envelopes carrying a `pulse` field reach the hub; plain broadcast/unicast
 * envelopes keep the fire-and-forget path.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { decodeFrame, decodeFrameWithStream, type Effect, encodeFrame, Endpoint, type Snapshot, StreamSet } from '@coinfra/pulse';
import { HEAD_PULSE_TARGET, type PulseFrameField, type UnicastEnvelope } from '@kraki/protocol';
import { getLogger } from './logger.js';
import { fp, trace } from './trace.js';

/** The two logical streams every head⇄device link carries (pulse spec §13).
 *  Keeping bulk off the live stream is what stops a reconnect-time burst of
 *  trace/range/attachment frames from head-of-line blocking live messages
 *  (echo, abort, status card) on the same downlink. */
const STREAM_LIVE = 0;
const STREAM_BULK = 1;

/** Head→device messages that are bulk (best-effort background / large):
 *  history replay, turn-trace batches, attachment chunks. Everything else is
 *  live. This classification runs at the FORWARD hop, keyed by the payload's
 *  decoded message `type` (the payload is the encrypted {blob,keys} JSON, but
 *  the head forwards the ORIGINAL delivered bytes from the source — which for
 *  a same-epoch source carry the inner type in the clear only after decrypt;
 *  so we instead classify by the SOURCE deliver's streamId, set by the
 *  originating tentacle/arm). See {@link forward}. */

/** GC policy — how aggressively the hub reclaims per-device outbox memory
 *  for peers that stay disconnected. Zero disables that step. Defaults tuned
 *  for a store-and-forward hub with many long-lived-but-often-offline peers
 *  (browser tabs closed, phones off, iPad in a drawer). See spec §11. */
export interface PulseHubGcConfig {
  /** After this many ms Disconnected, drop the endpoint's non-durable outbox
   *  (via `endpoint.purgeNonDurable`). Durable entries survive; they persist
   *  in `pulse_meta` via `snapshotDurable`. Default 5 * 60_000 (5 min). */
  purgeNonDurableAfterMs?: number;
  /** After this many ms Disconnected, drop the endpoint entirely from memory.
   *  Durable snapshot remains in SQLite so a future reconnect can rebuild it
   *  via `ep()`. Default 24 * 3600_000 (24 h). */
  evictEndpointAfterMs?: number;
  /** How often the GC scan runs. Default 60_000 (1 min). */
  intervalMs?: number;
}

const DEFAULT_GC: Required<PulseHubGcConfig> = {
  purgeNonDurableAfterMs: 5 * 60_000,
  evictEndpointAfterMs: 24 * 3600_000,
  intervalMs: 60_000,
};

/** How the hub reaches out: send bytes to a device, and resolve where a
 *  delivered payload should be forwarded. Injected so the hub stays decoupled
 *  from the WebSocket layer and testable. */
export interface PulseHubHost {
  /** Send a pulse-framed envelope's `pulse` string to `deviceId` if online.
   *  Returns true if the device is currently connected. */
  sendPulseTo(deviceId: string, pulseB64: string): boolean;
  /** Fan-out targets for a BROADCAST from `fromDevice`: the other devices of the
   *  same user that the delivered payload should be forwarded to. (A tentacle
   *  broadcasts to all the user's apps; an app that broadcasts, to the
   *  tentacles.) Empty for a pure unicast (routing comes from `to` instead). */
  broadcastTargets(fromDevice: string): string[];
  /** A delivered payload was addressed to the head itself (HEAD_PULSE_TARGET),
   *  not a forward destination. The payload is PLAINTEXT control JSON; hand it to
   *  head's own control dispatch, resolving `fromDevice` → its authenticated
   *  connection/state. */
  onDeliverToSelf(fromDevice: string, payload: Uint8Array): void;
  now(): number;
}

const b64encode = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

interface PerDevice {
  streams: StreamSet;
  /** live(0) and bulk(1) endpoints, cached for direct access (snapshot, GC).
   *  Both share the device's connection via the StreamSet. */
  live: Endpoint;
  bulk: Endpoint;
}

export class PulseHub {
  private readonly devices = new Map<string, PerDevice>();
  /** Capability is tracked both historically and for the concrete connection.
   *  While offline, a previously-v2 device keeps bulk in stream 1. On reconnect,
   *  current capability must be re-advertised, allowing a rolled-back/cached v1
   *  client under the same device id to receive a stream-0 fallback. */
  private readonly bulkCapableEver = new Set<string>();
  private readonly bulkCapableNow = new Set<string>();
  /** Devices from which this concrete connection received any valid Pulse
   *  frame. Used to distinguish a confirmed v1 rollback from a socket that
   *  closed before capability negotiation completed. */
  private readonly pulseSeenNow = new Set<string>();
  private readonly connectedDevices = new Set<string>();
  private readonly gc: Required<PulseHubGcConfig>;
  /** Unique even when two hub processes start in the same millisecond. */
  private readonly processEpoch = randomUUID();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly host: PulseHubHost,
    gc?: PulseHubGcConfig,
  ) {
    this.gc = { ...DEFAULT_GC, ...(gc ?? {}) };
    this.initSchema();
    this.loadCapabilities();
    this.startGc();
  }

  private initSchema(): void {
    const createOutbox = `CREATE TABLE pulse_outbox (
      device TEXT NOT NULL, stream INTEGER NOT NULL DEFAULT 0,
      seq TEXT NOT NULL, payload BLOB NOT NULL,
      dest TEXT NOT NULL, durable_dest INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device, stream, seq))`;
    const createMeta = `CREATE TABLE pulse_meta (
      device TEXT NOT NULL, stream INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL,
      PRIMARY KEY (device, stream))`;

    this.db.exec(createOutbox.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
    this.db.exec(createMeta.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
    this.db.exec(`CREATE TABLE IF NOT EXISTS pulse_capabilities (
      device TEXT PRIMARY KEY, bulk INTEGER NOT NULL DEFAULT 0)`);

    type Column = { name: string; pk: number };
    const columns = (table: string): Column[] =>
      this.db.prepare(`PRAGMA table_info(${table})`).all() as Column[];
    const hasPrimaryKey = (cols: Column[], expected: string[]): boolean =>
      expected.every((name, index) => cols.find((col) => col.name === name)?.pk === index + 1);

    const outboxColumns = columns('pulse_outbox');
    const metaColumns = columns('pulse_meta');
    const migrateOutbox = !outboxColumns.some((col) => col.name === 'stream')
      || !hasPrimaryKey(outboxColumns, ['device', 'stream', 'seq']);
    const migrateMeta = !metaColumns.some((col) => col.name === 'stream')
      || !hasPrimaryKey(metaColumns, ['device', 'stream']);
    if (!migrateOutbox && !migrateMeta) return;

    // Adding `stream` alone is insufficient: SQLite keeps the old primary key
    // (`device,seq` / `device`), so live seq=5 still collides with bulk seq=5.
    // Rebuild atomically and preserve every legacy row as stream 0.
    this.db.transaction(() => {
      if (migrateOutbox) {
        const sourceStream = outboxColumns.some((col) => col.name === 'stream') ? 'stream' : '0';
        this.db.exec('ALTER TABLE pulse_outbox RENAME TO pulse_outbox_legacy');
        this.db.exec(createOutbox);
        this.db.exec(`INSERT INTO pulse_outbox (device, stream, seq, payload, dest, durable_dest)
          SELECT device, ${sourceStream}, seq, payload, dest, durable_dest FROM pulse_outbox_legacy`);
        this.db.exec('DROP TABLE pulse_outbox_legacy');
      }
      if (migrateMeta) {
        const sourceStream = metaColumns.some((col) => col.name === 'stream') ? 'stream' : '0';
        this.db.exec('ALTER TABLE pulse_meta RENAME TO pulse_meta_legacy');
        this.db.exec(createMeta);
        this.db.exec(`INSERT INTO pulse_meta (device, stream, snapshot)
          SELECT device, ${sourceStream}, snapshot FROM pulse_meta_legacy`);
        this.db.exec('DROP TABLE pulse_meta_legacy');
      }
    })();
  }

  /** Ensure a per-device StreamSet exists (live + bulk endpoints, restoring
   *  each from SQLite if present). head endpoints are durable-supported (head
   *  is always-on + has disk). */
  private ep(deviceId: string): PerDevice {
    let d = this.devices.get(deviceId);
    if (d) return d;
    // ALWAYS mint a fresh epoch for this process, even when restoring. A
    // process restart is a new send-stream identity (spec §9): non-durable
    // sends in flight were lost, so the peer MUST learn the discontinuity
    // and reset its recvCursor, else our post-restart seq=1..N collide with
    // the pre-crash seq=1..N it already delivered and get silently dropped as
    // duplicates (2026-07-11 relay-restart device_joined-loss bug). Each
    // stream gets its own epoch so a RESET/burst on bulk cannot disturb the
    // live stream's cursor.
    const ts = this.host.now();
    const live = new Endpoint({
      epoch: `head:${this.processEpoch}:${deviceId}:live:${ts}`,
      durable: { supported: true },
      streamId: STREAM_LIVE,
      restore: this.loadSnapshot(deviceId, STREAM_LIVE),
    });
    const bulk = new Endpoint({
      epoch: `head:${this.processEpoch}:${deviceId}:bulk:${ts}`,
      durable: { supported: true },
      streamId: STREAM_BULK,
      restore: this.loadSnapshot(deviceId, STREAM_BULK),
    });
    d = { streams: new StreamSet([live, bulk]), live, bulk };
    this.devices.set(deviceId, d);
    return d;
  }

  /** A device connected — bring up its stream set (resume any persisted outbox). */
  onDeviceConnected(deviceId: string): void {
    if (this.closed || !this.db.open) return;
    this.connectedDevices.add(deviceId);
    this.bulkCapableNow.delete(deviceId);
    this.pulseSeenNow.delete(deviceId);
    const d = this.ep(deviceId);
    this.run(deviceId, d.streams.onConnected(this.host.now()));
    this.saveSnapshot(deviceId);
  }

  /** A device disconnected — its outboxes persist for resume. */
  onDeviceDisconnected(deviceId: string): void {
    if (this.closed || !this.db.open) return;
    this.connectedDevices.delete(deviceId);
    // A v2 StreamSet advertises stream 1 on every connection. If this complete
    // connection exchanged valid Pulse frames but never advertised stream 1,
    // the device was rolled back (or is a stale v1 client). Forget historical
    // v2 capability so offline bulk remains byte-compatible on stream 0.
    if (this.pulseSeenNow.has(deviceId) && !this.bulkCapableNow.has(deviceId)) {
      this.bulkCapableEver.delete(deviceId);
      this.db.prepare('DELETE FROM pulse_capabilities WHERE device = ?').run(deviceId);
    }
    this.pulseSeenNow.delete(deviceId);
    this.bulkCapableNow.delete(deviceId);
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.streams.onDisconnected(this.host.now());
  }

  /** Periodic tick for all stream sets (heartbeat, liveness, durable expiry). */
  tick(): void {
    if (this.closed || !this.db.open) return;
    const now = this.host.now();
    for (const [deviceId, d] of this.devices) {
      this.run(deviceId, d.streams.onTick(now));
    }
  }

  /**
   * A pulse-framed envelope arrived from `fromDevice`. `env.to` (for unicast) is
   * the routing destination the delivered payload should be forwarded to. Feed
   * the frame to the source endpoint and carry out the effects.
   */
  onPulseEnvelope(fromDevice: string, env: PulseFrameField & { to?: string }): void {
    if (this.closed || !this.db.open || !env.pulse) return;
    const d = this.ep(fromDevice);
    // A frame addressed to HEAD_PULSE_TARGET is consumed by the head itself, not
    // forwarded to a device. It still rides the source stream (same seq/ack/
    // resume as everything else) — only the `deliver` handling differs.
    const selfBound = env.to === HEAD_PULSE_TARGET;
    // Destinations for anything this device delivers: an explicit unicast `to`,
    // or (for a broadcast) the fan-out targets from the host. '@head' is a
    // routing sentinel, never a forward destination.
    const dests = selfBound
      ? []
      : (env.to ? [env.to] : this.host.broadcastTargets(fromDevice));
    const inLen = env.pulse.length;
    const bytes = b64decode(env.pulse);
    const decoded = decodeFrameWithStream(bytes);
    if (decoded) this.pulseSeenNow.add(fromDevice);
    if (decoded?.streamId === STREAM_BULK) {
      if (!this.bulkCapableEver.has(fromDevice)) {
        this.bulkCapableEver.add(fromDevice);
        this.db.prepare(
          'INSERT OR REPLACE INTO pulse_capabilities (device, bulk) VALUES (?, 1)',
        ).run(fromDevice);
      }
      this.bulkCapableNow.add(fromDevice);
    }
    trace('WS-RX', { from: fromDevice, to: env.to, selfBound, destCount: dests.length, pulseB64Len: inLen, stream: decoded?.streamId ?? 0 });
    // StreamSet demuxes by the v2 header's streamId and dispatches to the
    // owning per-stream endpoint. The deliver effect carries that streamId so
    // forward() can route onto the SAME stream on the destination device.
    const effects = d.streams.onBytes(bytes, this.host.now());
    const delivered = effects.filter((e) => e.t === 'deliver');
    if (delivered.length > 0) {
      for (const e of delivered) {
        if (e.t === 'deliver') trace('HUB-DELIVER', { from: fromDevice, stream: e.streamId ?? 0, seq: String(e.seq), fp: fp(e.payload), len: e.payload.length, durable: e.durable, coalesceKey: e.coalesceKey, selfBound });
      }
    }
    this.run(fromDevice, effects, dests, selfBound);
    const willSnapshot = effects.some((e) => e.t === 'store' || e.t === 'unstore');
    trace('HUB-ONPULSE', { from: fromDevice, effects: effects.map((e) => e.t), willSnapshot });
    // Only persist when a durable entry was added/removed (store/unstore effect).
    // Same rationale as forward() — saving on every message was the OOM cause.
    if (willSnapshot) this.saveSnapshot(fromDevice);
  }

  // ── Effect execution ────────────────────────────────────────────────────────

  private run(deviceId: string, effects: Effect[], dests?: string[], selfBound = false): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit':
          trace('HUB-TX', { to: deviceId, len: e.bytes.length });
          // Control/resend bytes go back to this device.
          this.host.sendPulseTo(deviceId, b64encode(e.bytes));
          break;
        case 'deliver':
          if (selfBound) {
            trace('HUB-DELIVER-SELF', { from: deviceId, seq: String(e.seq), len: e.payload.length });
            // Terminus at head: consume the plaintext control payload with the
            // source connection's auth context, instead of forwarding.
            this.host.onDeliverToSelf(deviceId, e.payload);
          } else {
            trace('HUB-FORWARD', { from: deviceId, stream: e.streamId ?? 0, seq: String(e.seq), fp: fp(e.payload), len: e.payload.length, durable: e.durable, coalesceKey: e.coalesceKey, dests: dests ?? [] });
            // Store-and-forward bridge: forward the reliable payload onto each
            // destination device's SAME stream (live or bulk), preserving
            // durable intent AND the send-time coalesce hint (pulse §12) so
            // state-covering streams (deltas, card state) collapse on the
            // arm-facing outbox if the arm is offline, instead of bursting on
            // reconnect. Routing onto the matching stream is what keeps bulk
            // (trace/range/attachment) from head-of-line blocking live
            // (echo/abort/card) on the downlink.
            const stream = e.streamId ?? STREAM_LIVE;
            for (const dest of dests ?? []) this.forward(dest, e.payload, e.durable, e.coalesceKey, stream);
          }
          break;
        case 'store':
          trace('HUB-STORE', { device: deviceId, stream: e.streamId ?? 0, seq: String(e.seq), len: e.payload.length, dests: dests ?? [] });
          this.storeOutbox(deviceId, e.streamId ?? STREAM_LIVE, e.seq, e.payload, (dests ?? []).join(','));
          break;
        case 'unstore':
          trace('HUB-UNSTORE', { device: deviceId, stream: e.streamId ?? 0, seqUpTo: String(e.seqUpTo) });
          this.unstoreOutbox(deviceId, e.streamId ?? STREAM_LIVE, e.seqUpTo);
          break;
        // reset-inbound / acked / open / close: nothing for the hub to do —
        // acked pruning already emits unstore; open/close are driven by the WS.
      }
    }
  }

  /** Forward a payload onto the destination device's outbound endpoint on the
   *  given stream. If the destination is offline, that stream's endpoint keeps
   *  it in its outbox (durable → also persisted to SQLite via the store effect)
   *  and resends on reconnect. */
  private forward(destDevice: string, payload: Uint8Array, durable: boolean, coalesceKey: string | undefined, stream: number): void {
    const d = this.ep(destDevice);
    // Compatibility during rolling deploys and for stale cached Web clients:
    // v1 peers do not understand stream-1 frames. Default to stream 0 until
    // this concrete connection advertises v2 by sending a stream-1 frame.
    const supportsBulk = this.connectedDevices.has(destDevice)
      ? this.bulkCapableNow.has(destDevice)
      : this.bulkCapableEver.has(destDevice);
    const actualStream = stream === STREAM_BULK && !supportsBulk ? STREAM_LIVE : stream;
    const { effects } = d.streams.send(actualStream, payload, { durable, coalesceKey });
    trace('FWD-SEND', { dest: destDevice, stream: actualStream, requestedStream: stream, fp: fp(payload), len: payload.length, durable, coalesceKey, effects: effects.map((e) => e.t) });
    // The destination endpoint's transmits go to the destination device; its
    // deliveries would bridge back (not used in one-way flows). No secondary
    // dest — a forwarded message is terminal at the destination device.
    this.run(destDevice, effects, undefined);
    const willSnapshot = effects.some((e) => e.t === 'store' || e.t === 'unstore');
    // Only persist the snapshot when a durable entry was actually added
    // (store effect emitted). Non-durable messages (deltas, user_message,
    // idle, etc.) do not change the durable outbox — saving on every forward
    // was the root cause of the 2026-07-09 head OOM: JSON.stringify +
    // SQLite INSERT per streaming delta × N online arms saturated V8 heap.
    if (willSnapshot) this.saveSnapshot(destDevice);
  }

  /** Head-ORIGINATED reliable send to a device (presence / preferences / voice
   *  responses). Same mechanism as `forward`, but the payload originates at the
   *  head rather than being relayed from another device. Non-durable by default:
   *  head-originated control (e.g. "device X joined") is ephemeral and must not
   *  be redelivered stale after the target reconnects. */
  sendToDevice(destDevice: string, payload: Uint8Array, opts?: { durable?: boolean; coalesceKey?: string }): void {
    // Head-originated control (presence, preferences, voice) is live traffic —
    // it must never queue behind bulk on the downlink.
    this.forward(destDevice, payload, opts?.durable ?? false, opts?.coalesceKey, STREAM_LIVE);
  }

  // ── SQLite persistence ──────────────────────────────────────────────────────

  private loadCapabilities(): void {
    const rows = this.db.prepare(
      'SELECT device FROM pulse_capabilities WHERE bulk = 1',
    ).all() as Array<{ device: string }>;
    for (const { device } of rows) this.bulkCapableEver.add(device);
  }

  private storeOutbox(device: string, stream: number, seq: bigint, payload: Uint8Array, dest?: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO pulse_outbox (device, stream, seq, payload, dest) VALUES (?, ?, ?, ?, ?)',
      )
      .run(device, stream, seq.toString(), Buffer.from(payload), dest ?? '');
  }

  private unstoreOutbox(device: string, stream: number, seqUpTo: bigint): void {
    this.db
      .prepare('DELETE FROM pulse_outbox WHERE device = ? AND stream = ? AND CAST(seq AS INTEGER) <= ?')
      .run(device, stream, Number(seqUpTo));
  }

  private saveSnapshot(device: string): void {
    const d = this.devices.get(device);
    if (!d) return;
    // Persist EACH stream's durable snapshot separately (pulse §11.3 + §13).
    // Non-durable entries are not persisted (same rationale as before: in-memory
    // only, may be lost on restart; persisting them caused the 2026-07-07 head
    // OOM). Each stream has its own seq space, so each must be snapshotted and
    // restored independently — mixing them would corrupt cursors.
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO pulse_meta (device, stream, snapshot) VALUES (?, ?, ?)',
    );
    stmt.run(device, STREAM_LIVE, JSON.stringify(d.live.snapshotDurable()));
    stmt.run(device, STREAM_BULK, JSON.stringify(d.bulk.snapshotDurable()));
  }

  private loadSnapshot(device: string, stream: number): Snapshot | undefined {
    const row = this.db
      .prepare('SELECT snapshot FROM pulse_meta WHERE device = ? AND stream = ?')
      .get(device, stream) as { snapshot: string } | undefined;
    return row ? (JSON.parse(row.snapshot) as Snapshot) : undefined;
  }

  /** On head boot, rebuild endpoints from persisted snapshots so durable
   *  outbox entries resume delivery once their destination reconnects. */
  recoverOnBoot(): void {
    if (this.closed || !this.db.open) return;
    const rows = this.db.prepare('SELECT device FROM pulse_meta').all() as Array<{ device: string }>;
    for (const { device } of rows) this.ep(device); // constructs + restores
  }

  /** Test/introspection: how many durable rows are held for a device across
   *  all streams. */
  outboxCount(device: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pulse_outbox WHERE device = ?')
      .get(device) as { n: number };
    return row.n;
  }

  /** In-memory endpoint count. Test/introspection. */
  endpointCount(): number {
    return this.devices.size;
  }

  /** Stop the periodic GC scan. Call on shutdown. */
  close(): void {
    this.closed = true;
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  // ── GC scan (spec §11.4) ────────────────────────────────────────────────

  private startGc(): void {
    if (this.gc.intervalMs <= 0) return;
    this.gcTimer = setInterval(() => {
      try { this.gcTick(); } catch (err) {
        getLogger().error('pulse-hub gc tick failed', { error: (err as Error).message });
      }
    }, this.gc.intervalMs);
    if (this.gcTimer && typeof (this.gcTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.gcTimer as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Two-tier GC per endpoint (see spec §11.4):
   *
   *   L1 (purgeNonDurableAfterMs, default 5 min)
   *     Endpoint disconnected ≥ L1 → `purgeNonDurable()`. Streaming deltas,
   *     idle markers, and other ephemera queued during the offline window
   *     get dropped. Durable messages (delete_session) survive.
   *
   *   L2 (evictEndpointAfterMs, default 24 h)
   *     Endpoint disconnected ≥ L2 → delete the in-memory endpoint entirely.
   *     Durable outbox rows remain in SQLite (via `pulse_meta` from prior
   *     `snapshotDurable` writes), so a future reconnect rebuilds the
   *     endpoint via `ep()` and picks them up.
   *
   * Only Disconnected endpoints are candidates. Endpoints without a
   * `disconnectedAtMs` (never disconnected in this run) are skipped.
   */
  gcTick(): void {
    const now = this.host.now();
    let purged = 0;
    let evicted = 0;
    for (const [deviceId, d] of this.devices) {
      // Both streams share the device's connection, so they disconnect together;
      // use the live stream's liveness as the proxy (bulk has the same timing).
      const disconnectedAt = d.live.disconnectedAtMs;
      if (d.live.link !== 'disconnected' || disconnectedAt === null) continue;
      const offlineMs = now - disconnectedAt;

      if (this.gc.evictEndpointAfterMs > 0 && offlineMs >= this.gc.evictEndpointAfterMs) {
        // L2: release the whole per-device set. Durable state stays in pulse_meta.
        trace('GC-EVICT', { device: deviceId, offlineMs });
        this.devices.delete(deviceId);
        evicted += 1;
        continue;
      }
      // L1: drop non-durable outbox entries on BOTH streams.
      for (const ep of [d.live, d.bulk]) {
        if (
          this.gc.purgeNonDurableAfterMs > 0
          && offlineMs >= this.gc.purgeNonDurableAfterMs
          && ep.nonDurableCount > 0
        ) {
          const { droppedSeqs } = ep.purgeNonDurable('gc-idle');
          if (droppedSeqs.length > 0) {
            purged += droppedSeqs.length;
            trace('GC-PURGE', { device: deviceId, stream: ep.stream, dropped: droppedSeqs.length, offlineMs });
          }
        }
      }
      if (purged > 0 || evicted > 0) this.saveSnapshot(deviceId);
    }
    if (purged > 0 || evicted > 0) {
      getLogger().info('pulse-hub gc', {
        purgedSeqs: purged,
        evictedEndpoints: evicted,
        totalEndpoints: this.devices.size,
      });
    }
  }
}

// Re-export the frame codec for the server to build/inspect pulse envelopes.
export { decodeFrame, encodeFrame };
export type { UnicastEnvelope };
