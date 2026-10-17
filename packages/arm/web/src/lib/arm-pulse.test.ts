import { decodeFrameWithStream, Endpoint, StreamSet, type Effect } from '@kraki/pulse';
import { describe, expect, it } from 'vitest';
import { ArmPulse, type ArmPulseHost } from './arm-pulse';

function b64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function unb64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function makePeer(): StreamSet {
  return new StreamSet([
    new Endpoint({ epoch: 'head:live', streamId: 0, random: () => 0.5 }),
    new Endpoint({ epoch: 'head:bulk', streamId: 1, random: () => 0.5 }),
  ]);
}

class ArmWorld {
  now = 0;
  readonly sent: Array<{ bytes: Uint8Array; target: string }> = [];
  readonly delivered: string[] = [];
  readonly acked: bigint[] = [];
  readonly arm: ArmPulse;
  readonly head = makePeer();

  constructor() {
    const host: ArmPulseHost = {
      now: () => this.now,
      sendPulseFrame: (pulse, target) => this.sent.push({ bytes: unb64(pulse), target }),
      onDelivered: (payload) => this.delivered.push(payload),
      onAcked: (seq) => this.acked.push(seq),
    };
    this.arm = new ArmPulse(host, 'arm');
  }

  connect(): void {
    this.arm.onConnected();
    const armHello = this.sent.splice(0);
    this.feedHead(this.head.onConnected(this.now));
    for (const { bytes } of armHello) this.feedHead(this.head.onBytes(bytes, this.now));
    this.pumpArmToHead();
  }

  pumpArmToHead(): void {
    for (;;) {
      const pending = this.sent.splice(0);
      if (pending.length === 0) return;
      for (const { bytes } of pending) this.feedHead(this.head.onBytes(bytes, this.now));
    }
  }

  feedHead(effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.t === 'transmit') this.arm.onFrame(b64(effect.bytes));
    }
  }
}

describe('ArmPulse multi-stream', () => {
  it('sends every Arm-originated command on byte-compatible live stream 0', () => {
    const world = new ArmWorld();
    world.connect();
    world.sent.length = 0;

    const seq = world.arm.send('{"type":"abort"}', 'tentacle-1', true);
    expect(seq).toBe(1n);
    const data = world.sent.find(({ bytes }) => decodeFrameWithStream(bytes)?.frame.t === 'data');
    expect(data).toBeDefined();
    expect(decodeFrameWithStream(data!.bytes)?.streamId).toBe(0);
    expect(data!.target).toBe('tentacle-1');
  });

  it('demuxes a stream-1 response into the normal delivery callback', () => {
    const world = new ArmWorld();
    world.connect();

    const payload = '{"type":"turn_trace_batch"}';
    world.feedHead(world.head.send(1, new TextEncoder().encode(payload)).effects);
    expect(world.delivered).toContain(payload);
  });

  it('delivers live while bulk is stalled behind a missing sequence', () => {
    const world = new ArmWorld();
    world.connect();

    const bulk1 = world.head.send(1, new TextEncoder().encode('bulk-1')).effects;
    const bulk2 = world.head.send(1, new TextEncoder().encode('bulk-2')).effects;
    // Drop bulk seq=1 and feed only seq=2. The bulk endpoint must wait.
    world.feedHead(bulk2);
    expect(world.delivered).not.toContain('bulk-2');

    // Independent live seq=1 must deliver immediately despite the bulk hole.
    world.feedHead(world.head.send(0, new TextEncoder().encode('live-1')).effects);
    expect(world.delivered).toContain('live-1');
    expect(world.delivered).not.toContain('bulk-2');

    // Repairing bulk seq=1 allows the bulk stream to make progress independently.
    world.feedHead(bulk1);
    expect(world.delivered).toContain('bulk-1');
  });

  it('preserves the command target when an unacked live frame retransmits', () => {
    const world = new ArmWorld();
    world.connect();
    world.sent.length = 0;

    world.arm.send('{"type":"remove_device"}', '@head', true);
    const first = world.sent.find(({ bytes }) => decodeFrameWithStream(bytes)?.frame.t === 'data');
    expect(first?.target).toBe('@head');

    // Drop DATA, reconnect both Pulse peers, and observe a resend outside send().
    world.sent.length = 0;
    world.arm.onDisconnected();
    world.head.onDisconnected(world.now);
    world.now += 1_000;
    world.arm.onConnected();
    const history = world.sent.splice(0);
    world.feedHead(world.head.onConnected(world.now));
    for (const { bytes } of history) world.feedHead(world.head.onBytes(bytes, world.now));

    const resent = world.sent.find(({ bytes }) => decodeFrameWithStream(bytes)?.frame.t === 'data');
    expect(resent).toBeDefined();
    expect(resent!.target).toBe('@head');
  });
});

describe('ArmPulse connection-scoped commands (Stop)', () => {
  function headDeliveries(effects: Effect[], into: string[]): Effect[] {
    for (const e of effects) if (e.t === 'deliver') into.push(new TextDecoder().decode(e.payload));
    return effects;
  }

  function reconnect(world: ArmWorld, delivered: string[]): void {
    world.arm.onDisconnected();
    world.head.onDisconnected(world.now);
    world.now += 1_000;
    world.arm.onConnected();
    const hello = world.sent.splice(0);
    world.feedHead(headDeliveries(world.head.onConnected(world.now), delivered));
    for (const { bytes } of hello) world.feedHead(headDeliveries(world.head.onBytes(bytes, world.now), delivered));
    for (;;) {
      const pending = world.sent.splice(0);
      if (pending.length === 0) break;
      for (const { bytes } of pending) world.feedHead(headDeliveries(world.head.onBytes(bytes, world.now), delivered));
    }
  }

  it('purges an unacked Stop at disconnect instead of retransmitting it into the next connection', () => {
    const world = new ArmWorld();
    world.connect();
    world.sent.length = 0;

    const seq = world.arm.send('{"type":"abort_session"}', 'tentacle-1', false, { connectionScoped: true });
    expect(seq).toBe(1n);
    expect(world.arm.connectionScopedCount).toBe(1);
    // The DATA frame is lost with the socket.
    world.sent.length = 0;

    const delivered: string[] = [];
    reconnect(world, delivered);
    // Ordinary traffic after reconnect still flows past the purged gap.
    world.arm.send('{"type":"send_input"}', 'tentacle-1', false);
    for (const { bytes } of world.sent.splice(0)) world.feedHead(headDeliveries(world.head.onBytes(bytes, world.now), delivered));

    expect(delivered).not.toContain('{"type":"abort_session"}');
    expect(delivered).toContain('{"type":"send_input"}');
    expect(world.arm.connectionScopedCount).toBe(0);
  });

  it('still retransmits ordinary unacked commands across reconnect', () => {
    const world = new ArmWorld();
    world.connect();
    world.sent.length = 0;

    world.arm.send('{"type":"abort_session"}', 'tentacle-1', false, { connectionScoped: true });
    world.arm.send('{"type":"send_input"}', 'tentacle-1', false);
    world.sent.length = 0;

    const delivered: string[] = [];
    reconnect(world, delivered);
    expect(delivered).toEqual(['{"type":"send_input"}']);
  });

  it('refuses a connection-scoped send while disconnected', () => {
    const world = new ArmWorld();
    world.connect();
    world.arm.onDisconnected();
    expect(world.arm.send('{"type":"abort_session"}', 'tentacle-1', false, { connectionScoped: true })).toBeNull();
    expect(world.arm.connectionScopedCount).toBe(0);
  });

  it('forgets an acknowledged Stop so the next disconnect purges nothing', () => {
    const world = new ArmWorld();
    world.connect();
    world.sent.length = 0;
    world.arm.send('{"type":"abort_session"}', 'tentacle-1', false, { connectionScoped: true });
    world.pumpArmToHead();
    world.now += 15_000; // Head piggybacks its ACK on the heartbeat
    world.feedHead(world.head.onTick(world.now));
    expect(world.acked.at(-1)).toBe(1n);
    expect(world.arm.connectionScopedCount).toBe(0);
  });
});
