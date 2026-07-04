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
 * This lives ALONGSIDE the legacy fire-and-forget path: only envelopes carrying
 * a `pulse` field reach the hub. Flag-gated by KRAKI_PULSE at the call site.
 */

import type Database from 'better-sqlite3';
import { decodeFrame, type Effect, encodeFrame, Endpoint, type Snapshot } from '@kraki/pulse';
import type { PulseFrameField, UnicastEnvelope } from '@kraki/protocol';

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

  constructor(
    private readonly db: Database.Database,
    private readonly host: PulseHubHost,
  ) {
    this.initSchema();
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
    // Destinations for anything this device delivers: an explicit unicast `to`,
    // or (for a broadcast) the fan-out targets from the host.
    const dests = env.to ? [env.to] : this.host.broadcastTargets(fromDevice);
    this.run(fromDevice, d.endpoint.onBytes(b64decode(env.pulse), this.host.now()), dests);
    this.saveSnapshot(fromDevice);
  }

  // ── Effect execution ────────────────────────────────────────────────────────

  private run(deviceId: string, effects: Effect[], dests?: string[]): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit':
          // Control/resend bytes go back to this device.
          this.host.sendPulseTo(deviceId, b64encode(e.bytes));
          break;
        case 'deliver':
          // Store-and-forward bridge: forward the reliable payload onto each
          // destination device's endpoint, preserving the durable intent.
          for (const dest of dests ?? []) this.forward(dest, e.payload, e.durable);
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
  private forward(destDevice: string, payload: Uint8Array, durable: boolean): void {
    const d = this.ep(destDevice);
    const { effects } = d.endpoint.send(payload, { durable });
    // The destination endpoint's transmits go to the destination device; its
    // deliveries would bridge back (not used in one-way flows). No secondary
    // dest — a forwarded message is terminal at the destination device.
    this.run(destDevice, effects, undefined);
    this.saveSnapshot(destDevice);
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
    this.db
      .prepare('INSERT OR REPLACE INTO pulse_meta (device, snapshot) VALUES (?, ?)')
      .run(device, JSON.stringify(d.endpoint.snapshot()));
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
}

// Re-export the frame codec for the server to build/inspect pulse envelopes.
export { decodeFrame, encodeFrame };
export type { UnicastEnvelope };
