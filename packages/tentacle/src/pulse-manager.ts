/**
 * PulseManager (tentacle side) — owns one pulse Endpoint per consumer (arm)
 * device and translates between Kraki's relay-client and the neutral pulse core.
 *
 * It sits INSIDE the E2E boundary: it hands the relay-client a pulse-framed
 * plaintext to encrypt per device, and consumes decrypted pulse frames coming
 * back. It never touches the socket or crypto itself — the relay-client owns
 * those. Effects `open`/`close` are ignored (all devices share the one head WS;
 * the tentacle cannot dial per device — link lifecycle is driven explicitly).
 *
 * Epochs are persisted per device under KRAKI_HOME so resume survives a daemon
 * restart (spec §10). Endpoints are GC'd when a device is removed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Endpoint, packPulsePlaintext, type Snapshot } from '@kraki/pulse';
import { createLogger } from './logger.js';

const logger = createLogger('pulse');

/** What the manager needs the relay-client to do: encrypt+send bytes to one
 *  device, and hand a delivered payload back to the normal message path. */
export interface PulseHost {
  /** Encrypt `plaintext` for exactly `deviceId` and unicast it. */
  sendToDevice(deviceId: string, plaintext: string): void;
  /** A reliable payload was delivered in order for this peer — feed it to the
   *  existing consumer/producer handler as if it just arrived. */
  onDelivered(deviceId: string, payload: string): void;
  /** Monotonic clock (ms). Injectable for tests. */
  now(): number;
}

export class PulseManager {
  private endpoints = new Map<string, Endpoint>();
  private readonly dir: string;

  constructor(
    private readonly host: PulseHost,
    krakiHome: string,
    private readonly enabled: boolean,
  ) {
    this.dir = join(krakiHome, 'pulse');
    if (this.enabled) {
      try {
        mkdirSync(this.dir, { recursive: true });
      } catch (err) {
        logger.warn({ err }, 'could not create pulse dir; snapshots disabled');
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Get (or lazily create) the endpoint for a consumer device. */
  private ep(deviceId: string): Endpoint {
    let e = this.endpoints.get(deviceId);
    if (!e) {
      const restore = this.loadSnapshot(deviceId);
      e = new Endpoint({ epoch: restore?.epoch ?? this.freshEpoch(deviceId), restore: restore ?? undefined });
      this.endpoints.set(deviceId, e);
    }
    return e;
  }

  /** Send a reliable message to one device through its pulse endpoint. */
  send(deviceId: string, messageJson: string): void {
    const e = this.ep(deviceId);
    const { effects } = e.send(new TextEncoder().encode(messageJson));
    this.runTransmits(deviceId, effects);
    this.persist(deviceId, e);
  }

  /** The device's link just came up (device_joined / key learned). */
  onConnected(deviceId: string): void {
    const e = this.ep(deviceId);
    this.run(deviceId, e.onConnected(this.host.now()));
  }

  /** The shared head WS dropped — every device's link is down. */
  onDisconnectedAll(): void {
    const now = this.host.now();
    for (const [deviceId, e] of this.endpoints) {
      this.run(deviceId, e.onDisconnected(now));
    }
  }

  /** Feed a decrypted inbound pulse frame to the right endpoint. */
  onFrame(deviceId: string, frame: Uint8Array): void {
    const e = this.ep(deviceId);
    this.run(deviceId, e.onBytes(frame, this.host.now()));
    this.persist(deviceId, e);
  }

  /** Periodic tick for all endpoints (drives heartbeat + liveness). Called from
   *  the relay-client's existing staleCheck timer. */
  tick(): void {
    const now = this.host.now();
    for (const [deviceId, e] of this.endpoints) {
      this.run(deviceId, e.onTick(now));
    }
  }

  /** Drop an endpoint when its device is removed. */
  remove(deviceId: string): void {
    this.endpoints.delete(deviceId);
  }

  // ── effect execution ──────────────────────────────────────────────────────

  private run(deviceId: string, effects: ReturnType<Endpoint['onTick']>): void {
    for (const eff of effects) {
      switch (eff.t) {
        case 'transmit':
          this.host.sendToDevice(deviceId, packPulsePlaintext(this.mySrc(deviceId), eff.bytes));
          break;
        case 'deliver':
          this.host.onDelivered(deviceId, new TextDecoder().decode(eff.payload));
          break;
        case 'reset-inbound':
          // Inbound history from this arm is gone; arm→tentacle reliability is
          // best-effort recovered by the arm re-sending. Nothing to replay here.
          logger.warn({ deviceId, fromSeq: String(eff.fromSeq) }, 'pulse reset-inbound');
          break;
        // open / close: ignored — shared head WS, lifecycle driven explicitly.
        case 'open':
        case 'close':
          break;
      }
    }
  }

  private runTransmits(deviceId: string, effects: ReturnType<Endpoint['send']>['effects']): void {
    this.run(deviceId, effects);
  }

  /** The `src` on frames we emit is our OWN device id, so the arm routes them to
   *  the endpoint it keeps for us. We don't have it here directly; the host
   *  stamps it. We pass the consumer deviceId placeholder and let the host
   *  override — but simpler: the tentacle's own id is stable, injected once. */
  private ownDeviceId = '';
  setOwnDeviceId(id: string): void {
    this.ownDeviceId = id;
  }
  private mySrc(_deviceId: string): string {
    return this.ownDeviceId;
  }

  // ── snapshot persistence ───────────────────────────────────────────────────

  private persist(deviceId: string, e: Endpoint): void {
    if (!this.enabled) return;
    try {
      writeFileSync(this.snapPath(deviceId), JSON.stringify(e.snapshot()), 'utf8');
    } catch (err) {
      logger.debug({ err, deviceId }, 'pulse snapshot write failed');
    }
  }

  private loadSnapshot(deviceId: string): Snapshot | null {
    if (!this.enabled) return null;
    try {
      const p = this.snapPath(deviceId);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf8')) as Snapshot;
    } catch {
      return null;
    }
  }

  private snapPath(deviceId: string): string {
    return join(this.dir, `${deviceId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  private freshEpoch(deviceId: string): string {
    // Stable-ish but unique per (device, boot): deviceId + a random suffix.
    // Randomness is fine here — epoch only needs to change on cold start.
    return `${this.ownDeviceId || 't'}:${deviceId}:${Math.random().toString(36).slice(2, 10)}`;
  }
}
