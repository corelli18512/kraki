import { describe, expect, it } from 'vitest';
import { Endpoint } from '../endpoint.js';
import { DEFAULT_PARAMS } from '../types.js';
import { decodeFrame } from '../wire.js';

const transmits = (effects: ReturnType<Endpoint['onTick']>) =>
  effects
    .filter((e) => e.t === 'transmit')
    .map((e) => decodeFrame((e as { bytes: Uint8Array }).bytes)!);

describe('CONGESTION: a lagging but advancing peer cursor is not loss', () => {
  it('never resends frames still in flight while the peer keeps catching up', () => {
    const a = new Endpoint({ epoch: 'a', random: () => 0.5 });
    a.onConnected(0);
    // A slow link: 100 frames are queued; the peer drains one every 500 ms and
    // advertises its cursor in idle heartbeats every 15 s.
    for (let i = 0; i < 100; i++) a.send(new Uint8Array([i]));
    let resent = 0;
    const interval = DEFAULT_PARAMS.heartbeatIntervalMs;
    for (let t = interval; t <= 45_000; t += interval) {
      const cursor = BigInt(Math.floor(t / 500));
      resent += transmits(a.onFrame({ t: 'heartbeat', ack: cursor }, t)).filter(
        (f) => f.t === 'data',
      ).length;
      resent += transmits(a.onTick(t + 1)).filter((f) => f.t === 'data').length;
    }
    expect(resent).toBe(0);
  });

  it('repairs a cursor that stopped advancing for a heartbeat interval', () => {
    const a = new Endpoint({ epoch: 'a', random: () => 0.5 });
    a.onConnected(0);
    for (let i = 0; i < 5; i++) a.send(new Uint8Array([i]));
    const interval = DEFAULT_PARAMS.heartbeatIntervalMs;
    // Peer got two frames, then the rest were lost on the wire.
    expect(
      transmits(a.onFrame({ t: 'heartbeat', ack: 2n }, 1_000)).filter((f) => f.t === 'data'),
    ).toHaveLength(0);
    const repair = transmits(a.onTick(1_000 + interval)).filter((f) => f.t === 'data');
    expect(repair.map((f) => (f as { seq: bigint }).seq)).toEqual([3n, 4n, 5n]);
  });

  it('still repairs at once on an explicit hole ACK', () => {
    const a = new Endpoint({ epoch: 'a', random: () => 0.5 });
    a.onConnected(0);
    for (let i = 0; i < 3; i++) a.send(new Uint8Array([i]));
    const repair = transmits(a.onFrame({ t: 'ack', ack: 1n }, 10)).filter((f) => f.t === 'data');
    expect(repair.map((f) => (f as { seq: bigint }).seq)).toEqual([2n, 3n]);
  });
});
