import { decodeFrameWithStream, Endpoint, StreamSet, type Effect } from '@coinfra/pulse';
import { describe, expect, it } from 'vitest';
import { streamForType, TentaclePulse, type TentaclePulseHost } from '../tentacle-pulse.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

function peer(epoch = 'head'): StreamSet {
  return new StreamSet([
    new Endpoint({ epoch: `${epoch}:live`, streamId: 0, random: () => 0.5 }),
    new Endpoint({ epoch: `${epoch}:bulk`, streamId: 1, random: () => 0.5 }),
  ]);
}

class PulseWorld {
  now = 0;
  readonly sent: Array<{ bytes: Uint8Array; target?: string }> = [];
  readonly history: Array<{ bytes: Uint8Array; target?: string }> = [];
  readonly delivered: string[] = [];
  readonly pulse: TentaclePulse;
  head = peer();

  constructor() {
    const host: TentaclePulseHost = {
      now: () => this.now,
      sendPulseFrame: (text, target) => {
        const entry = { bytes: unb64(text), target };
        this.sent.push(entry);
        this.history.push(entry);
      },
      onDelivered: (payload) => this.delivered.push(payload),
    };
    this.pulse = new TentaclePulse(host, 'tentacle');
  }

  connectHead(): void {
    this.pulse.onConnected();
    this.feedHeadEffects(this.head.onConnected(this.now));
    this.pumpTentacleToHead();
  }

  reconnectHead(): void {
    this.pulse.onDisconnected();
    this.head.onDisconnected(this.now);
    this.now += 1_000;
    this.pulse.onConnected();
    this.feedHeadEffects(this.head.onConnected(this.now));
    this.pumpTentacleToHead();
  }

  pumpTentacleToHead(): void {
    for (;;) {
      const outgoing = this.sent.splice(0);
      if (outgoing.length === 0) return;
      for (const { bytes } of outgoing) {
        this.feedHeadEffects(this.head.onBytes(bytes, this.now));
      }
    }
  }

  private feedHeadEffects(effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.t === 'transmit') this.pulse.onFrame(b64(effect.bytes));
    }
  }
}

describe('TentaclePulse multi-stream', () => {
  it('classifies every replay/history/trace/attachment batch as bulk', () => {
    for (const type of [
      'session_replay_batch',
      'session_messages_batch',
      'session_messages_range_batch',
      'turn_trace_batch',
      'attachment_data',
    ]) {
      expect(streamForType(type), type).toBe(1);
    }
    for (const type of [
      'session_list',
      'user_message',
      'assistant_delta',
      'interrupted_turn',
      'idle',
      'request_attachment',
      'request_turn_trace',
      undefined,
    ]) {
      expect(streamForType(type), String(type)).toBe(0);
    }
  });

  it('falls requested bulk back to byte-compatible stream 0 before v2 is advertised', () => {
    const world = new PulseWorld();
    world.pulse.onConnected();
    world.sent.length = 0;

    world.pulse.send('{"bulk":1}', 'legacy-arm', false, undefined, 1);
    const data = world.sent.find(({ bytes }) => decodeFrameWithStream(bytes)?.frame.t === 'data');
    expect(data).toBeDefined();
    expect(decodeFrameWithStream(data!.bytes)?.streamId).toBe(0);
    expect(data!.target).toBe('legacy-arm');
  });

  it('uses stream 1 after the Head advertises v2', () => {
    const world = new PulseWorld();
    world.connectHead();
    world.sent.length = 0;

    world.pulse.send('{"bulk":1}', 'new-arm', false, undefined, 1);
    const data = world.sent.find(({ bytes }) => decodeFrameWithStream(bytes)?.frame.t === 'data');
    expect(data).toBeDefined();
    expect(decodeFrameWithStream(data!.bytes)?.streamId).toBe(1);
    expect(data!.target).toBe('new-arm');
  });

  it('keeps the original unicast target on a stream-1 reconnect resend', () => {
    const world = new PulseWorld();
    world.connectHead();
    world.sent.length = 0;

    world.pulse.send('{"attachment":1}', 'arm-only', false, undefined, 1);
    const first = world.sent.find(({ bytes }) => decodeFrameWithStream(bytes)?.frame.t === 'data');
    expect(decodeFrameWithStream(first!.bytes)?.streamId).toBe(1);
    expect(first!.target).toBe('arm-only');

    // Drop the DATA: do not pump it into the Head. Reconnect with peer cursor 0,
    // forcing Pulse to resend the same stream-1 seq outside send()'s call stack.
    world.sent.length = 0;
    const historyStart = world.history.length;
    world.reconnectHead();
    const resent = world.history.slice(historyStart).find(({ bytes }) => {
      const decoded = decodeFrameWithStream(bytes);
      return decoded?.streamId === 1 && decoded.frame.t === 'data';
    });
    expect(resent).toBeDefined();
    expect(resent!.target).toBe('arm-only');
  });

  it('keeps live and bulk seq=1 targets independent', () => {
    const world = new PulseWorld();
    world.connectHead();
    world.sent.length = 0;

    world.pulse.send('{"live":1}', 'live-arm', false, undefined, 0);
    world.pulse.send('{"bulk":1}', 'bulk-arm', false, undefined, 1);
    const data = world.sent.filter(({ bytes }) => decodeFrameWithStream(bytes)?.frame.t === 'data');
    const byStream = new Map(data.map((entry) => [decodeFrameWithStream(entry.bytes)!.streamId, entry.target]));
    expect(byStream.get(0)).toBe('live-arm');
    expect(byStream.get(1)).toBe('bulk-arm');
  });
});
