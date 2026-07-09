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

import type Database from 'better-sqlite3';
import { decodeFrame, type Effect, encodeFrame, Endpoint, type Snapshot } from '@coinfra/pulse';
import { HEAD_PULSE_TARGET, type PulseFrameField, type UnicastEnvelope } from '@kraki/protocol';
import { getLogger } from './logger.js';

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
  endpoint: Endpoint;
  /** Destination for messages this device sends us (the `to` of its unicasts).
   *  A device streams to exactly one peer per logical connection in Kraki's
   *  model (arm→its tentacle, tentacle→its arms); we forward each delivered
   *  payload to the destination recorded for the in-flight envelope. */
}

export class PulseHub {
  private readonly devices = new Map<string, PerDevice>();
  private readonly gc: Required<PulseHubGcConfig>;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly host: PulseHubHost,
    gc?: PulseHubGcConfig,
  ) {
    this.gc = { ...DEFAULT_GC, ...(gc ?? {}) };
    this.initSchema();
    this.startGc();
  }

  private initSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS pulse_outbox (
      device TEXT NOT NULL, seq TEXT NOT NULL, payload BLOB NOT NULL,
      dest TEXT NOT NULL, durable_dest INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device, seq))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS pulse_meta (
      device TEXT PRIMARY KEY, snapshot TEXT NOT NULL)`);
  }

  /** Ensure an endpoint exists for a device (restoring from SQLite if present).
   *  head endpoints are durable-supported (head is always-on + has disk). */
  private ep(deviceId: string): PerDevice {
    let d = this.devices.get(deviceId);
    if (!d) {
      const restore = this.loadSnapshot(deviceId);
      const endpoint = new Endpoint({
        epoch: restore?.epoch ?? `head:${deviceId}:${this.host.now()}`,
        durable: { supported: true },
        restore,
      });
      d = { endpoint };
      this.devices.set(deviceId, d);
    }
    return d;
  }

  /** A device connected — bring up its endpoint (resume any persisted stream). */
  onDeviceConnected(deviceId: string): void {
    const d = this.ep(deviceId);
    this.run(deviceId, d.endpoint.onConnected(this.host.now()));
    this.saveSnapshot(deviceId);
  }

  /** A device disconnected — its endpoint's outbox persists for resume. */
  onDeviceDisconnected(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.endpoint.onDisconnected(this.host.now());
  }

  /** Periodic tick for all endpoints (heartbeat, liveness, durable expiry). */
  tick(): void {
    const now = this.host.now();
    for (const [deviceId, d] of this.devices) {
      this.run(deviceId, d.endpoint.onTick(now));
    }
  }

  /**
   * A pulse-framed envelope arrived from `fromDevice`. `env.to` (for unicast) is
   * the routing destination the delivered payload should be forwarded to. Feed
   * the frame to the source endpoint and carry out the effects.
   */
  onPulseEnvelope(fromDevice: string, env: PulseFrameField & { to?: string }): void {
    if (!env.pulse) return;
    const d = this.ep(fromDevice);
    // A frame addressed to HEAD_PULSE_TARGET is consumed by the head itself, not
    // forwarded to a device. It still rides the source endpoint (same seq/ack/
    // resume as everything else) — only the `deliver` handling differs.
    const selfBound = env.to === HEAD_PULSE_TARGET;
    // Destinations for anything this device delivers: an explicit unicast `to`,
    // or (for a broadcast) the fan-out targets from the host. '@head' is a
    // routing sentinel, never a forward destination.
    const dests = selfBound
      ? []
      : (env.to ? [env.to] : this.host.broadcastTargets(fromDevice));
    this.run(fromDevice, d.endpoint.onBytes(b64decode(env.pulse), this.host.now()), dests, selfBound);
    this.saveSnapshot(fromDevice);
  }

  // ── Effect execution ────────────────────────────────────────────────────────

  private run(deviceId: string, effects: Effect[], dests?: string[], selfBound = false): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit':
          // Control/resend bytes go back to this device.
          this.host.sendPulseTo(deviceId, b64encode(e.bytes));
          break;
        case 'deliver':
          if (selfBound) {
            // Terminus at head: consume the plaintext control payload with the
            // source connection's auth context, instead of forwarding.
            this.host.onDeliverToSelf(deviceId, e.payload);
          } else {
            // Store-and-forward bridge: forward the reliable payload onto each
            // destination device's endpoint, preserving durable intent AND the
            // send-time coalesce hint (pulse §12) so state-covering streams
            // (deltas, card state) collapse on the arm-facing outbox if the arm
            // is offline, instead of bursting on reconnect.
            for (const dest of dests ?? []) this.forward(dest, e.payload, e.durable, e.coalesceKey);
          }
          break;
        case 'store':
          this.storeOutbox(deviceId, e.seq, e.payload, (dests ?? []).join(','));
          break;
        case 'unstore':
          this.unstoreOutbox(deviceId, e.seqUpTo);
          break;
        // reset-inbound / acked / open / close: nothing for the hub to do —
        // acked pruning already emits unstore; open/close are driven by the WS.
      }
    }
  }

  /** Forward a payload onto the destination device's outbound endpoint. If the
   *  destination is offline, the pulse endpoint keeps it in its outbox (durable
   *  → also persisted to SQLite via the store effect) and resends on reconnect. */
  private forward(destDevice: string, payload: Uint8Array, durable: boolean, coalesceKey?: string): void {
    const d = this.ep(destDevice);
    const { effects } = d.endpoint.send(payload, { durable, coalesceKey });
    // The destination endpoint's transmits go to the destination device; its
    // deliveries would bridge back (not used in one-way flows). No secondary
    // dest — a forwarded message is terminal at the destination device.
    this.run(destDevice, effects, undefined);
    this.saveSnapshot(destDevice);
  }

  /** Head-ORIGINATED reliable send to a device (presence / preferences / voice
   *  responses). Same mechanism as `forward`, but the payload originates at the
   *  head rather than being relayed from another device. Non-durable by default:
   *  head-originated control (e.g. "device X joined") is ephemeral and must not
   *  be redelivered stale after the target reconnects. */
  sendToDevice(destDevice: string, payload: Uint8Array, opts?: { durable?: boolean; coalesceKey?: string }): void {
    this.forward(destDevice, payload, opts?.durable ?? false, opts?.coalesceKey);
  }

  // ── SQLite persistence ──────────────────────────────────────────────────────

  private storeOutbox(device: string, seq: bigint, payload: Uint8Array, dest?: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO pulse_outbox (device, seq, payload, dest) VALUES (?, ?, ?, ?)',
      )
      .run(device, seq.toString(), Buffer.from(payload), dest ?? '');
  }

  private unstoreOutbox(device: string, seqUpTo: bigint): void {
    this.db
      .prepare('DELETE FROM pulse_outbox WHERE device = ? AND CAST(seq AS INTEGER) <= ?')
      .run(device, Number(seqUpTo));
  }

  private saveSnapshot(device: string): void {
    const d = this.devices.get(device);
    if (!d) return;
    // Use snapshotDurable() (pulse §11.3) — persisting non-durable entries to
    // disk both violates their "in-memory only, may be lost on restart"
    // contract AND is the exact root cause of the 2026-07-07 head OOM
    // (each save re-serialized an ever-growing in-memory outbox for offline
    // peers). Durable entries (currently just delete_session in kraki) are
    // preserved so a future reconnect delivers them.
    this.db
      .prepare('INSERT OR REPLACE INTO pulse_meta (device, snapshot) VALUES (?, ?)')
      .run(device, JSON.stringify(d.endpoint.snapshotDurable()));
  }

  private loadSnapshot(device: string): Snapshot | undefined {
    const row = this.db.prepare('SELECT snapshot FROM pulse_meta WHERE device = ?').get(device) as
      | { snapshot: string }
      | undefined;
    return row ? (JSON.parse(row.snapshot) as Snapshot) : undefined;
  }

  /** On head boot, rebuild endpoints from persisted snapshots so durable
   *  outbox entries resume delivery once their destination reconnects. */
  recoverOnBoot(): void {
    const rows = this.db.prepare('SELECT device FROM pulse_meta').all() as Array<{ device: string }>;
    for (const { device } of rows) this.ep(device); // constructs + restores
  }

  /** Test/introspection: how many durable rows are held for a device. */
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
      const disconnectedAt = d.endpoint.disconnectedAtMs;
      if (d.endpoint.link !== 'disconnected' || disconnectedAt === null) continue;
      const offlineMs = now - disconnectedAt;

      if (this.gc.evictEndpointAfterMs > 0 && offlineMs >= this.gc.evictEndpointAfterMs) {
        // L2: release the endpoint. Durable state stays in pulse_meta.
        this.devices.delete(deviceId);
        evicted += 1;
        continue;
      }
      if (
        this.gc.purgeNonDurableAfterMs > 0
        && offlineMs >= this.gc.purgeNonDurableAfterMs
        && d.endpoint.nonDurableCount > 0
      ) {
        // L1: drop non-durable outbox entries only.
        const { droppedSeqs } = d.endpoint.purgeNonDurable('gc-idle');
        if (droppedSeqs.length > 0) {
          purged += droppedSeqs.length;
          this.saveSnapshot(deviceId);
        }
      }
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
