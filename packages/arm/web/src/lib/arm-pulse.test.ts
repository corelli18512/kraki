import { decodeFrameWithStream, Endpoint, StreamSet, type Effect } from '@coinfra/pulse';
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
