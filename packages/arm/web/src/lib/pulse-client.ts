import { Endpoint, isReliableType, packPulsePlaintext, tryUnpackPulse } from '@kraki/pulse';
import type { InnerMessage } from '@kraki/protocol';
import { createLogger } from './logger';

const logger = createLogger('pulse');

/**
 * PulseClient (arm side) — owns one pulse Endpoint per tentacle device and makes
 * tentacle→arm reliable messages resumable across disconnects. Mirror of the
 * tentacle's PulseManager.
 *
 * Receive: a decrypted pulse frame → the peer's Endpoint → an in-order `deliver`
 * hands the original message back to the normal `handleDataMessage` path.
 * Ack/resume traffic (and, when enabled, reliable arm→tentacle sends) are
 * encrypted and unicast back to the owning tentacle.
 *
 * Snapshots persist to localStorage so resume survives a tab reload.
 */
export interface PulseClientHost {
  /** Our own (arm) deviceId — stamped as `src` on frames we emit. */
  myDeviceId(): string | null;
  /** Encrypt `plaintext` for exactly `tentacleDeviceId` and unicast it. */
  sendToDevice(tentacleDeviceId: string, plaintext: string): void;
  /** A reliable message was delivered in order — feed it to the UI pipeline. */
  deliver(msg: InnerMessage): void;
  now(): number;
}

const SNAP_PREFIX = 'kraki_pulse_';

export class PulseClient {
  private endpoints = new Map<string, Endpoint>();

  constructor(
    private readonly host: PulseClientHost,
    private readonly enabled: boolean,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  private ep(tentacleDeviceId: string): Endpoint {
    let e = this.endpoints.get(tentacleDeviceId);
    if (!e) {
      const restore = this.loadSnapshot(tentacleDeviceId);
      e = new Endpoint({
        epoch: restore?.epoch ?? this.freshEpoch(tentacleDeviceId),
        restore: restore ?? undefined,
      });
      this.endpoints.set(tentacleDeviceId, e);
    }
    return e;
  }

  /** Consume a decrypted plaintext. Returns true if it was a pulse frame. */
  tryFrame(plaintext: string): boolean {
    if (!this.enabled) return false;
    const unpacked = tryUnpackPulse(plaintext);
    if (!unpacked) return false;
    const e = this.ep(unpacked.src);
    this.run(unpacked.src, e.onBytes(unpacked.frame, this.host.now()));
    this.persist(unpacked.src, e);
    return true;
  }

  /** The link to the relay is up — resume every known tentacle stream. */
  onConnected(): void {
    if (!this.enabled) return;
    const now = this.host.now();
    for (const [deviceId, e] of this.endpoints) {
      this.run(deviceId, e.onConnected(now));
    }
  }

  /** A tentacle device is known/online — ensure its endpoint exists + resumes. */
  onTentacleOnline(tentacleDeviceId: string): void {
    if (!this.enabled) return;
    const e = this.ep(tentacleDeviceId);
    this.run(tentacleDeviceId, e.onConnected(this.host.now()));
  }

  /** The relay link dropped. */
  onDisconnected(): void {
    if (!this.enabled) return;
    const now = this.host.now();
    for (const [deviceId, e] of this.endpoints) {
      this.run(deviceId, e.onDisconnected(now));
    }
  }

  /** Periodic tick (heartbeat + liveness). */
  tick(): void {
    if (!this.enabled) return;
    const now = this.host.now();
    for (const [deviceId, e] of this.endpoints) {
      this.run(deviceId, e.onTick(now));
    }
  }

  /** Send a reliable arm→tentacle message through the pulse endpoint. Returns
   *  true if pulse handled it (caller should NOT also send it the legacy way). */
  send(tentacleDeviceId: string, msg: Record<string, unknown>): boolean {
    if (!this.enabled || !isReliableType(msg.type)) return false;
    const e = this.ep(tentacleDeviceId);
    const { effects } = e.send(new TextEncoder().encode(JSON.stringify(msg)));
    this.run(tentacleDeviceId, effects);
    this.persist(tentacleDeviceId, e);
    return true;
  }

  private run(tentacleDeviceId: string, effects: ReturnType<Endpoint['onTick']>): void {
    const src = this.host.myDeviceId();
    for (const eff of effects) {
      switch (eff.t) {
        case 'transmit':
          if (src) this.host.sendToDevice(tentacleDeviceId, packPulsePlaintext(src, eff.bytes));
          break;
        case 'deliver':
          try {
            this.host.deliver(JSON.parse(new TextDecoder().decode(eff.payload)) as InnerMessage);
          } catch (err) {
            logger.error('pulse deliver parse failed', err);
          }
          break;
        case 'reset-inbound':
          logger.warn('pulse reset-inbound', { from: String(eff.fromSeq) });
          break;
        case 'open':
        case 'close':
          break; // shared relay link; lifecycle driven explicitly
      }
    }
  }

  // ── snapshot persistence (localStorage) ────────────────────────────────────

  private persist(tentacleDeviceId: string, e: Endpoint): void {
    if (!this.enabled) return;
    try {
      localStorage.setItem(SNAP_PREFIX + tentacleDeviceId, JSON.stringify(e.snapshot()));
    } catch {
      /* quota / unavailable — resume degrades to reset-inbound, not loss */
    }
  }

  private loadSnapshot(tentacleDeviceId: string): ReturnType<Endpoint['snapshot']> | null {
    try {
      const raw = localStorage.getItem(SNAP_PREFIX + tentacleDeviceId);
      return raw ? (JSON.parse(raw) as ReturnType<Endpoint['snapshot']>) : null;
    } catch {
      return null;
    }
  }

  private freshEpoch(tentacleDeviceId: string): string {
    const me = this.host.myDeviceId() ?? 'arm';
    return `${me}:${tentacleDeviceId}:${Math.random().toString(36).slice(2, 10)}`;
  }
}
