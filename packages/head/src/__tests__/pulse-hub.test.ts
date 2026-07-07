/**
 * PulseHub — head as a per-hop pulse bridge. Validates the real hub API (not
 * the earlier standalone spike): per-device endpoints, store-and-forward,
 * SQLite durability, and recovery across a restart of head.
 *
 * Topology under test:
 *   arm ⇄(pulse, via hub)⇄ tentacle
 * The hub owns one Endpoint per device. arm→tentacle messages are delivered to
 * the hub's arm-endpoint, then forwarded onto the hub's tentacle-endpoint.
 */

import Database from 'better-sqlite3';
import { decodeFrame, Endpoint, encodeFrame } from '@coinfra/pulse';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEAD_PULSE_TARGET } from '@kraki/protocol';
import { PulseHub, type PulseHubHost } from '../pulse-hub.js';

const ARM = 'arm-1';
const TENT = 'tentacle-1';

/** A test world: the hub in the middle, plus a real arm + tentacle pulse
 *  endpoint on each side. Wires are controllable (online/offline per device). */
class World {
  now = 0;
  hub: PulseHub;
  arm: Endpoint;
  tentacle: Endpoint;
  armOnline = false;
  tentOnline = false;
  /** What the tentacle application finally received (payload markers). */
  tentReceived: number[] = [];
  /** acked seqs the arm observed (i.e. head confirmed receipt). */
  armAcked: bigint[] = [];
  /** Head-terminated payloads (deliver-to-self), decoded as UTF-8 strings. */
  selfReceived: string[] = [];

  constructor(db: Database.Database) {
    const host: PulseHubHost = {
      now: () => this.now,
      sendPulseTo: (deviceId, pulseB64) => this.deliverToDevice(deviceId, pulseB64),
      broadcastTargets: () => [], // this test uses explicit `to` (unicast)
      onDeliverToSelf: (_fromDevice, payload) => {
        this.selfReceived.push(Buffer.from(payload).toString('utf8'));
      },
    };
    this.hub = new PulseHub(db, host);
    this.arm = new Endpoint({ epoch: 'arm', random: () => 0.5 });
    this.tentacle = new Endpoint({ epoch: 'tentacle', random: () => 0.5 });
  }

  /** Hub → device: deliver a pulse frame to the arm or tentacle endpoint. */
  private deliverToDevice(deviceId: string, pulseB64: string): boolean {
    const bytes = new Uint8Array(Buffer.from(pulseB64, 'base64'));
    if (deviceId === ARM) {
      if (!this.armOnline) return false;
      this.pumpArm(this.arm.onBytes(bytes, this.now));
      return true;
    }
    if (deviceId === TENT) {
      if (!this.tentOnline) return false;
      this.pumpTent(this.tentacle.onBytes(bytes, this.now));
      return true;
    }
    return false;
  }

  // device endpoint effects → back into the hub (as if the device sent them)
  private pumpArm(effects: ReturnType<Endpoint['onTick']>): void {
    for (const e of effects) {
      if (e.t === 'acked') this.armAcked.push(e.seqUpTo);
      if (e.t === 'transmit' && this.armOnline) {
        // arm → hub, addressed to the tentacle
        this.hub.onPulseEnvelope(ARM, { pulse: b64(e.bytes), to: TENT });
      }
    }
  }
  private pumpTent(effects: ReturnType<Endpoint['onTick']>): void {
    for (const e of effects) {
      if (e.t === 'deliver') this.tentReceived.push(e.payload[0] ?? -1);
      if (e.t === 'transmit' && this.tentOnline) {
        // tentacle → hub, addressed back to the arm
        this.hub.onPulseEnvelope(TENT, { pulse: b64(e.bytes), to: ARM });
      }
    }
  }

  connectArm(): void {
    this.armOnline = true;
    this.hub.onDeviceConnected(ARM);
    this.pumpArm(this.arm.onConnected(this.now));
  }
  connectTentacle(): void {
    this.tentOnline = true;
    this.hub.onDeviceConnected(TENT);
    this.pumpTent(this.tentacle.onConnected(this.now));
  }

  /** arm sends an app payload (opaque marker) toward the tentacle, durable? */
  armSend(marker: number, durable: boolean): void {
    this.pumpArm(this.arm.send(new Uint8Array([marker]), { durable }).effects);
  }

  /** arm sends a HEAD-terminated control payload (addressed to '@head'). The
   *  head consumes it via onDeliverToSelf instead of forwarding to a device. */
  armSendToHead(text: string): void {
    const { effects } = this.arm.send(new TextEncoder().encode(text), { durable: false });
    for (const e of effects) {
      if (e.t === 'transmit' && this.armOnline) {
        this.hub.onPulseEnvelope(ARM, { pulse: b64(e.bytes), to: HEAD_PULSE_TARGET });
      }
    }
  }

  advance(ms: number): void {
    const target = this.now + ms;
    while (this.now < target) {
      this.now += Math.min(1000, target - this.now);
      this.pumpArm(this.arm.onTick(this.now));
      this.pumpTent(this.tentacle.onTick(this.now));
      this.hub.tick();
    }
  }
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

describe('PulseHub: head as per-hop bridge', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('bridges a plain message arm → head → tentacle when both online', () => {
    const w = new World(db);
    w.connectArm();
    w.connectTentacle();
    w.armSend(7, false);
    w.advance(20_000);
    expect(w.tentReceived).toContain(7);
    // arm learned head received it (hop-A ack)
    expect(w.armAcked.length).toBeGreaterThan(0);
  });

  it('deliver-to-self: a frame addressed to @head is consumed by head, NOT forwarded', () => {
    const w = new World(db);
    w.connectArm();
    w.connectTentacle();
    w.armSendToHead('{"type":"update_preferences","preferences":{"theme":"dark"}}');
    w.advance(20_000);
    // Head consumed the plaintext control payload...
    expect(w.selfReceived).toEqual(['{"type":"update_preferences","preferences":{"theme":"dark"}}']);
    // ...and did NOT forward it to the tentacle.
    expect(w.tentReceived).toHaveLength(0);
    // The source (arm) still got its hop-A ack — reliable like any other send.
    expect(w.armAcked.length).toBeGreaterThan(0);
  });

  it('deliver-to-self: multiple head-bound frames each consumed once, in order', () => {
    const w = new World(db);
    w.connectArm();
    w.connectTentacle();
    w.armSendToHead('{"type":"remove_device","deviceId":"dev_x"}');
    w.armSendToHead('{"type":"register_push_token","payload":{"provider":"web_push"}}');
    w.advance(20_000);
    expect(w.selfReceived).toEqual([
      '{"type":"remove_device","deviceId":"dev_x"}',
      '{"type":"register_push_token","payload":{"provider":"web_push"}}',
    ]);
    expect(w.tentReceived).toHaveLength(0);
  });

  it('persists a durable message while tentacle OFFLINE, delivers on reconnect', () => {
    const w = new World(db);
    w.connectArm();
    // tentacle offline
    w.armSend(9, true);
    w.advance(20_000);

    // head acked the arm (message safely in head) and holds a durable row for
    // the tentacle-bound endpoint.
    expect(w.armAcked.length).toBeGreaterThan(0);
    expect(w.hub.outboxCount(TENT)).toBe(1);
    expect(w.tentReceived).toEqual([]);

    // tentacle comes online → head resends from its durable outbox.
    w.connectTentacle();
    w.advance(20_000);
    expect(w.tentReceived).toContain(9);
    expect(w.hub.outboxCount(TENT)).toBe(0); // cleared after tentacle acks
  });

  it('recovers a durable message across a RESTART of head (from SQLite)', () => {
    // Phase 1: arm sends durable while tentacle offline; head persists; head
    // "crashes" (drop the World/hub, keep the SQLite db).
    {
      const w = new World(db);
      w.connectArm();
      w.armSend(11, true);
      w.advance(20_000);
      expect(w.hub.outboxCount(TENT)).toBe(1);
    }

    // Durable row survives on disk with the hub object gone.
    const held = db.prepare('SELECT COUNT(*) AS n FROM pulse_outbox WHERE device = ?').get(TENT) as {
      n: number;
    };
    expect(held.n).toBe(1);

    // Phase 2: head restarts — new World/hub, SAME db. Endpoints restore from
    // their SQLite snapshot (lazily on first use, or eagerly via recoverOnBoot);
    // the durable outbox payload survives because snapshot() persists it.
    // (Verified with teeth: breaking loadSnapshot fails THIS test only.)
    const w2 = new World(db);
    w2.hub.recoverOnBoot(); // eager restore; lazy ep() would also work
    w2.connectTentacle();
    w2.advance(20_000);
    expect(w2.tentReceived).toContain(11);
  });
});
