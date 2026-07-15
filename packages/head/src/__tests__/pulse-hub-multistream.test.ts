import Database from 'better-sqlite3';
import { decodeFrameWithStream, encodeFrame, Endpoint, StreamSet, type Effect } from '@coinfra/pulse';
import { afterEach, describe, expect, it } from 'vitest';
import { PulseHub, type PulseHubGcConfig, type PulseHubHost } from '../pulse-hub.js';

const ARM = 'arm-multi';
const TENTACLE = 'tentacle-multi';
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

function endpoints(epoch: string): { streams: StreamSet; live: Endpoint; bulk: Endpoint } {
  const live = new Endpoint({ epoch: `${epoch}:live`, streamId: 0, random: () => 0.5 });
  const bulk = new Endpoint({ epoch: `${epoch}:bulk`, streamId: 1, random: () => 0.5 });
  return { streams: new StreamSet([live, bulk]), live, bulk };
}

class MultiStreamWorld {
  now = 0;
  readonly arm = endpoints('arm');
  readonly tentacle = endpoints('tentacle');
  readonly hub: PulseHub;
  armOnline = false;
  tentacleOnline = false;
  armReceived: Array<{ stream: number; marker: number }> = [];
  tentacleReceived: Array<{ stream: number; marker: number }> = [];
  headToArmStreams: number[] = [];
  headToTentacleStreams: number[] = [];

  constructor(readonly db: Database.Database, gc: PulseHubGcConfig = { intervalMs: 0 }) {
    const host: PulseHubHost = {
      now: () => this.now,
      sendPulseTo: (deviceId, pulse) => this.deliverToDevice(deviceId, pulse),
      broadcastTargets: (from) => from === ARM ? [TENTACLE] : [ARM],
      onDeliverToSelf: () => undefined,
    };
    this.hub = new PulseHub(db, host, gc);
  }

  connectArm(): void {
    this.armOnline = true;
    // The WebSocket is usable by both peers before either HELLO is delivered.
    // Mark the client endpoints connected first, then attach the hub, and only
    // then put the client's HELLO effects on the wire.
    const effects = this.arm.streams.onConnected(this.now);
    this.hub.onDeviceConnected(ARM);
    this.pumpArm(effects);
  }

  connectTentacle(): void {
    this.tentacleOnline = true;
    const effects = this.tentacle.streams.onConnected(this.now);
    this.hub.onDeviceConnected(TENTACLE);
    this.pumpTentacle(effects);
  }

  disconnectArm(): void {
    this.armOnline = false;
    this.hub.onDeviceDisconnected(ARM);
    this.arm.streams.onDisconnected(this.now);
  }

  disconnectTentacle(): void {
    this.tentacleOnline = false;
    this.hub.onDeviceDisconnected(TENTACLE);
    this.tentacle.streams.onDisconnected(this.now);
  }

  armSend(stream: number, marker: number, durable = false): void {
    this.pumpArm(this.arm.streams.send(stream, new Uint8Array([marker]), { durable }).effects);
  }

  tentacleSend(stream: number, marker: number, durable = false): void {
    this.pumpTentacle(this.tentacle.streams.send(stream, new Uint8Array([marker]), { durable }).effects);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.now += Math.min(1000, end - this.now);
      this.pumpArm(this.arm.streams.onTick(this.now));
      this.pumpTentacle(this.tentacle.streams.onTick(this.now));
      this.hub.tick();
    }
  }

  private deliverToDevice(deviceId: string, pulse: string): boolean {
    const bytes = unb64(pulse);
    const stream = decodeFrameWithStream(bytes)?.streamId ?? -1;
    if (deviceId === ARM) {
      this.headToArmStreams.push(stream);
      if (!this.armOnline) return false;
      this.pumpArm(this.arm.streams.onBytes(bytes, this.now));
      return true;
    }
    if (deviceId === TENTACLE) {
      this.headToTentacleStreams.push(stream);
      if (!this.tentacleOnline) return false;
      this.pumpTentacle(this.tentacle.streams.onBytes(bytes, this.now));
      return true;
    }
    return false;
  }

  private pumpArm(effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.t === 'deliver') {
        this.armReceived.push({ stream: effect.streamId ?? 0, marker: effect.payload[0] ?? -1 });
      } else if (effect.t === 'transmit' && this.armOnline) {
        this.hub.onPulseEnvelope(ARM, { pulse: b64(effect.bytes), to: TENTACLE });
      }
    }
  }

  private pumpTentacle(effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.t === 'deliver') {
        this.tentacleReceived.push({ stream: effect.streamId ?? 0, marker: effect.payload[0] ?? -1 });
      } else if (effect.t === 'transmit' && this.tentacleOnline) {
        this.hub.onPulseEnvelope(TENTACLE, { pulse: b64(effect.bytes), to: ARM });
      }
    }
  }
}

describe('PulseHub multi-stream persistence and forwarding', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('atomically migrates the pre-stream schema and preserves stream-0 rows', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`CREATE TABLE pulse_outbox (
      device TEXT NOT NULL, seq TEXT NOT NULL, payload BLOB NOT NULL,
      dest TEXT NOT NULL, durable_dest INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device, seq));
      CREATE TABLE pulse_meta (
      device TEXT PRIMARY KEY, snapshot TEXT NOT NULL);`);
    db.prepare('INSERT INTO pulse_outbox (device, seq, payload, dest) VALUES (?, ?, ?, ?)')
      .run('legacy-device', '1', Buffer.from([7]), 'legacy-dest');
    db.prepare('INSERT INTO pulse_meta (device, snapshot) VALUES (?, ?)')
      .run('legacy-device', JSON.stringify({ epoch: 'legacy', sendSeq: '1', recvCursor: '0', outboxBase: '0', outbox: [] }));

    const hub = new PulseHub(db, {
      now: () => 0,
      sendPulseTo: () => false,
      broadcastTargets: () => [],
      onDeliverToSelf: () => undefined,
    }, { intervalMs: 0 });

    const outboxPk = (db.prepare('PRAGMA table_info(pulse_outbox)').all() as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    const metaPk = (db.prepare('PRAGMA table_info(pulse_meta)').all() as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    expect(outboxPk).toEqual(['device', 'stream', 'seq']);
    expect(metaPk).toEqual(['device', 'stream']);

    expect(db.prepare('SELECT stream, seq, hex(payload) AS payload FROM pulse_outbox').get())
      .toEqual({ stream: 0, seq: '1', payload: '07' });
    expect(db.prepare('SELECT stream FROM pulse_meta').get()).toEqual({ stream: 0 });

    expect(() => {
      db.prepare('INSERT INTO pulse_outbox (device, stream, seq, payload, dest) VALUES (?, ?, ?, ?, ?)')
        .run('legacy-device', 1, '1', Buffer.from([8]), 'bulk-dest');
      db.prepare('INSERT INTO pulse_meta (device, stream, snapshot) VALUES (?, ?, ?)')
        .run('legacy-device', 1, '{}');
    }).not.toThrow();
    expect(hub.outboxCount('legacy-device')).toBe(2);
    hub.close();
  });

  it('preserves stream identity in both directions through the hub', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const world = new MultiStreamWorld(db);
    world.connectArm();
    world.connectTentacle();

    world.armSend(0, 10);
    world.armSend(1, 11);
    world.tentacleSend(0, 20);
    world.tentacleSend(1, 21);
    world.advance(5_000);

    expect(world.tentacleReceived).toEqual([
      { stream: 0, marker: 10 },
      { stream: 1, marker: 11 },
    ]);
    expect(world.armReceived).toEqual([
      { stream: 0, marker: 20 },
      { stream: 1, marker: 21 },
    ]);
    world.hub.close();
  });

  it('keeps equal live and bulk seq values in independent durable rows', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const world = new MultiStreamWorld(db);
    world.connectArm();
    world.connectTentacle();
    world.disconnectTentacle();

    world.armSend(0, 30, true);
    world.armSend(1, 31, true);
    world.advance(1_000);

    const rows = db.prepare(
      'SELECT stream, seq, hex(payload) AS payload FROM pulse_outbox WHERE device = ? ORDER BY stream',
    ).all(TENTACLE);
    expect(rows).toEqual([
      { stream: 0, seq: '1', payload: '1E' },
      { stream: 1, seq: '1', payload: '1F' },
    ]);
    expect(world.hub.outboxCount(TENTACLE)).toBe(2);

    world.connectTentacle();
    // Normal in-order DATA is cumulatively acknowledged by the next heartbeat.
    world.advance(20_000);
    expect(world.tentacleReceived).toEqual(expect.arrayContaining([
      { stream: 0, marker: 30 },
      { stream: 1, marker: 31 },
    ]));
    expect(world.hub.outboxCount(TENTACLE)).toBe(0);
    world.hub.close();
  });

  it('recovers equal live and bulk durable seq values across a Head restart', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const beforeRestart = new MultiStreamWorld(db);
    beforeRestart.connectArm();
    beforeRestart.connectTentacle();
    beforeRestart.disconnectTentacle();
    beforeRestart.armSend(0, 40, true);
    beforeRestart.armSend(1, 41, true);
    beforeRestart.advance(1_000);
    expect(beforeRestart.hub.outboxCount(TENTACLE)).toBe(2);
    beforeRestart.hub.close();

    const afterRestart = new MultiStreamWorld(db);
    afterRestart.hub.recoverOnBoot();
    afterRestart.connectTentacle();
    afterRestart.advance(20_000);
    expect(afterRestart.tentacleReceived).toEqual(expect.arrayContaining([
      { stream: 0, marker: 40 },
      { stream: 1, marker: 41 },
    ]));
    expect(afterRestart.hub.outboxCount(TENTACLE)).toBe(0);
    afterRestart.hub.close();
  });

  it('remembers v2 capability across a Head restart so offline bulk stays isolated', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const beforeRestart = new MultiStreamWorld(db);
    beforeRestart.connectArm();
    beforeRestart.connectTentacle();
    expect(db.prepare('SELECT bulk FROM pulse_capabilities WHERE device = ?').get(ARM))
      .toEqual({ bulk: 1 });
    beforeRestart.hub.close();

    const afterRestart = new MultiStreamWorld(db);
    afterRestart.connectTentacle();
    // ARM is offline after the Head restart. Its persisted capability must keep
    // this producer bulk frame in stream 1 rather than contaminating live.
    afterRestart.tentacleSend(1, 45, true);
    afterRestart.advance(1_000);
    expect(db.prepare(
      'SELECT stream, seq, hex(payload) AS payload FROM pulse_outbox WHERE device = ?',
    ).get(ARM)).toEqual({ stream: 1, seq: '1', payload: '2D' });
    afterRestart.hub.close();
  });

  it('forgets historical v2 capability after a confirmed v1 rollback', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const sentStreams: number[] = [];
    const hub = new PulseHub(db, {
      now: () => 0,
      sendPulseTo: (device, pulse) => {
        if (device === ARM) {
          sentStreams.push(decodeFrameWithStream(unb64(pulse))?.streamId ?? -1);
        }
        return false;
      },
      broadcastTargets: () => [],
      onDeliverToSelf: () => undefined,
    }, { intervalMs: 0 });

    db.prepare('INSERT INTO pulse_capabilities (device, bulk) VALUES (?, 1)').run(ARM);
    hub.close();

    const restarted = new PulseHub(db, {
      now: () => 0,
      sendPulseTo: (device, pulse) => {
        if (device === ARM) {
          sentStreams.push(decodeFrameWithStream(unb64(pulse))?.streamId ?? -1);
        }
        return false;
      },
      broadcastTargets: () => [],
      onDeliverToSelf: () => undefined,
    }, { intervalMs: 0 });
    restarted.onDeviceConnected(ARM);

    // A stream-0-only endpoint emits byte-compatible v1 frames and never
    // advertises stream 1 during this connection.
    const legacy = new Endpoint({ epoch: 'rolled-back-v1', streamId: 0 });
    for (const effect of legacy.onConnected(0)) {
      if (effect.t === 'transmit') {
        restarted.onPulseEnvelope(ARM, { pulse: b64(effect.bytes), to: '@head' });
      }
    }
    restarted.onDeviceDisconnected(ARM);
    expect(db.prepare('SELECT bulk FROM pulse_capabilities WHERE device = ?').get(ARM))
      .toBeUndefined();

    // The separate fallback test below verifies that an unrecognized peer is
    // routed over stream 0. This test locks the state transition that makes a
    // rolled-back device unrecognized again, including persistence across a
    // subsequent Head restart.
    restarted.close();
    const afterRollbackRestart = new PulseHub(db, {
      now: () => 0,
      sendPulseTo: () => false,
      broadcastTargets: () => [],
      onDeliverToSelf: () => undefined,
    }, { intervalMs: 0 });
    expect(db.prepare('SELECT bulk FROM pulse_capabilities WHERE device = ?').get(ARM))
      .toBeUndefined();
    afterRollbackRestart.close();
  });

  it('purges disconnected non-durable entries independently on both streams', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const world = new MultiStreamWorld(db, {
      intervalMs: 0,
      purgeNonDurableAfterMs: 1_000,
      evictEndpointAfterMs: 0,
    });
    world.connectArm();
    world.connectTentacle();
    world.disconnectTentacle();
    world.armSend(0, 50);
    world.armSend(1, 51);
    world.advance(2_000);
    world.hub.gcTick();

    world.connectTentacle();
    world.advance(20_000);
    expect(world.tentacleReceived).toEqual([]);
    world.hub.close();
  });

  it('drops an unknown stream without forwarding, persisting, or disturbing live', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const world = new MultiStreamWorld(db);
    world.connectArm();
    world.connectTentacle();
    world.tentacleReceived.length = 0;

    const unknown = encodeFrame({
      t: 'data',
      seq: 1n,
      ack: 0n,
      payload: new Uint8Array([77]),
      durable: true,
    }, 9);
    expect(() => world.hub.onPulseEnvelope(ARM, { pulse: b64(unknown), to: TENTACLE }))
      .not.toThrow();
    world.armSend(0, 78);
    world.advance(20_000);

    expect(world.tentacleReceived).toEqual([{ stream: 0, marker: 78 }]);
    expect(world.hub.outboxCount(TENTACLE)).toBe(0);
    world.hub.close();
  });

  it('falls bulk back to stream 0 for a peer that never advertises v2', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const sentStreams: number[] = [];
    const hub = new PulseHub(db, {
      now: () => 0,
      sendPulseTo: (_device, pulse) => {
        sentStreams.push(decodeFrameWithStream(unb64(pulse))?.streamId ?? -1);
        return true;
      },
      broadcastTargets: () => [],
      onDeliverToSelf: () => undefined,
    }, { intervalMs: 0 });

    hub.onDeviceConnected('legacy-arm');
    sentStreams.length = 0;
    // Simulate a source stream-1 DATA frame. The destination never sent a
    // stream-1 HELLO, so forwarding must use byte-compatible stream 0.
    const source = endpoints('source');
    const sourceFrames = source.streams.onConnected(0)
      .concat(source.streams.send(1, new Uint8Array([99])).effects)
      .filter((effect): effect is Extract<Effect, { t: 'transmit' }> => effect.t === 'transmit');
    for (const frame of sourceFrames) {
      const decoded = decodeFrameWithStream(frame.bytes);
      if (decoded?.streamId === 1 && decoded.frame.t === 'data') {
        hub.onPulseEnvelope('source', { pulse: b64(frame.bytes), to: 'legacy-arm' });
      }
    }

    expect(sentStreams).toContain(0);
    expect(sentStreams).not.toContain(1);
    hub.close();
  });
});
