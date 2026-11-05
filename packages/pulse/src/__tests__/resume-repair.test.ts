/**
 * Resume and repair after a relay restart (QA K-031, K-137, K-298).
 *
 * Each test drives two bare endpoints by hand so the exact frame order of a
 * real reconnect is reproduced (the World harness runs its handshake
 * synchronously and cannot interleave a stale in-flight frame).
 */
import { describe, expect, it } from 'vitest';
import { Endpoint } from '../endpoint.js';
import type { Effect, Snapshot } from '../types.js';
import { decodeFrame, encodeFrame } from '../wire.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function transmits(effects: Effect[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const e of effects) if (e.t === 'transmit') out.push(e.bytes);
  return out;
}

/** Two endpoints joined by an ordered, lossless link; frames handed over in
 *  the order the test chooses. Records what each side delivers. */
function link(a: Endpoint, b: Endpoint) {
  const deliveredA: string[] = [];
  const deliveredB: string[] = [];
  const resetsB: bigint[] = [];
  const toB = (effects: Effect[], now = 1): void => {
    for (const bytes of transmits(effects)) {
      const out = b.onBytes(bytes, now);
      for (const e of out) {
        if (e.t === 'deliver') deliveredB.push(dec.decode(e.payload));
        if (e.t === 'reset-inbound') resetsB.push(e.fromSeq);
      }
      toA(out, now);
    }
  };
  const toA = (effects: Effect[], now = 1): void => {
    for (const bytes of transmits(effects)) {
      const out = a.onBytes(bytes, now);
      for (const e of out) if (e.t === 'deliver') deliveredA.push(dec.decode(e.payload));
      toB(out, now);
    }
  };
  return { deliveredA, deliveredB, resetsB, toA, toB };
}

describe('K-031: a relay restored from a durable-only snapshot keeps reaching the computer', () => {
  // Relay (A) restarts from {sendSeq 8, outboxBase 6, outbox [7 durable]}: the
  // non-durable seq 8 is gone. The computer (B) kept running with cursor 17 of
  // the relay's previous epoch and piggybacks that stale ack=17 on the first
  // DATA it sends after reconnecting.
  function setup() {
    const restore: Snapshot = {
      epoch: 'relay:old',
      sendSeq: '8',
      outboxBase: '6',
      outbox: [
        { seq: '7', payloadB64: Buffer.from('durable7').toString('base64'), durable: true },
      ],
      recvCursor: '0',
      peerEpoch: 'computer:1',
      disconnectedAtMs: null,
    };
    const relay = new Endpoint({ epoch: 'relay:new', durable: { supported: true }, restore });
    const computer = new Endpoint({
      epoch: 'computer:1',
      restore: {
        epoch: 'computer:1',
        sendSeq: '0',
        outboxBase: '0',
        outbox: [],
        recvCursor: '17',
        peerEpoch: 'relay:old',
      },
    });
    return { relay, computer, ...link(relay, computer) };
  }

  for (const order of ['relay HELLO first', 'computer frames first'] as const) {
    it(`delivers every later relay message (${order})`, () => {
      const { relay, computer, deliveredB, toA, toB } = setup();
      const relayHello = relay.onConnected(1);
      const computerHello = computer.onConnected(1);
      const computerData = computer.send(enc.encode('up')).effects; // carries ack=17
      if (order === 'relay HELLO first') {
        toB(relayHello);
        toA(computerHello);
        toA(computerData);
      } else {
        toA(computerHello);
        toA(computerData);
        toB(relayHello);
      }
      for (let i = 0; i < 4; i++) toB(relay.send(enc.encode(`m${i}`)).effects);
      expect(deliveredB).toEqual(['durable7', 'm0', 'm1', 'm2', 'm3']);
    });
  }

  it('announces the tail gap when resetting a peer that is behind the retained base', () => {
    const { relay } = setup();
    relay.onConnected(1);
    // Same-epoch HELLO with a cursor below outboxBase=6.
    const hello = encodeFrame({
      t: 'hello',
      epoch: 'computer:1',
      recvEpoch: 'relay:new',
      recvCursor: 2n,
      durableSupported: false,
      maxRetentionMs: 0n,
    });
    const frames = transmits(relay.onBytes(hello, 2)).map((b) => decodeFrame(b));
    expect(frames.map((f) => (f?.t === 'reset' ? `reset:${f.oldest}` : f?.t))).toEqual([
      'reset:7',
      'data',
      'reset:9',
    ]);
  });

  it('repairs a peer whose hole ACK is below the retained base instead of ignoring it', () => {
    const relay = new Endpoint({ epoch: 'relay:1' });
    const computer = new Endpoint({ epoch: 'computer:1' });
    const { deliveredB, toA, toB } = link(relay, computer);
    toB(relay.onConnected(1));
    toA(computer.onConnected(1));
    toB(relay.send(enc.encode('a')).effects);
    // A bogus piggybacked ack (e.g. a cursor from the relay's previous epoch)
    // prunes seq 2 before the computer has it; seq 2 is then lost in flight.
    relay.send(enc.encode('lost'));
    const bogus = encodeFrame({ t: 'data', seq: 1n, ack: 2n, payload: enc.encode('up'), durable: false });
    toB(relay.onBytes(bogus, 1));
    expect(relay.outboxSize).toBe(0);
    // Every later message is a hole for the computer; its ACK(1) is below the
    // relay's base (2). The relay must announce the gap rather than drop it.
    toB(relay.send(enc.encode('b')).effects);
    toB(relay.send(enc.encode('c')).effects);
    expect(deliveredB).toEqual(['a', 'b', 'c']);
  });
});

describe('K-137: the HELLO resume resend is not repeated for in-flight hole ACKs', () => {
  it('resends the backlog once after a reconnect', () => {
    const tentacle = new Endpoint({ epoch: 't:1' });
    const head = new Endpoint({ epoch: 'h:1' });
    const { deliveredB, toA, toB } = link(tentacle, head);
    toB(tentacle.onConnected(0));
    toA(head.onConnected(0));
    toB(tentacle.send(enc.encode('m1')).effects);
    tentacle.onDisconnected(1);
    head.onDisconnected(1);
    // Backlog queued while offline.
    for (let i = 2; i <= 6; i++) tentacle.send(enc.encode(`m${i}`));

    // Reconnect. The tentacle sends its HELLO and two live messages before it
    // has read the head's HELLO; the head treats each live message as a hole.
    const tentacleOut = [...tentacle.onConnected(2)];
    tentacleOut.push(...tentacle.send(enc.encode('m7')).effects);
    tentacleOut.push(...tentacle.send(enc.encode('m8')).effects);
    const headHello = transmits(head.onConnected(2));
    const holeAcks: Uint8Array[] = [];
    for (const bytes of transmits(tentacleOut)) holeAcks.push(...transmits(head.onBytes(bytes, 2)));
    expect(holeAcks.map((b) => decodeFrame(b)?.t)).toEqual(['ack', 'ack']);

    // The tentacle now reads the head's HELLO (resume resend), then the two
    // in-flight hole ACKs. Count DATA frames it puts on the wire.
    const wire: Uint8Array[] = [];
    for (const bytes of headHello) wire.push(...transmits(tentacle.onBytes(bytes, 3)));
    for (const bytes of holeAcks) wire.push(...transmits(tentacle.onBytes(bytes, 3)));
    const dataSeqs = wire
      .map((b) => decodeFrame(b))
      .filter((f) => f?.t === 'data')
      .map((f) => (f?.t === 'data' ? f.seq : 0n));
    expect(dataSeqs).toEqual([2n, 3n, 4n, 5n, 6n, 7n, 8n]);

    toB(wire.map((bytes): Effect => ({ t: 'transmit', bytes })), 3);
    expect(deliveredB).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
  });

  it('still retries the resume resend when it was lost', () => {
    const tentacle = new Endpoint({ epoch: 't:1' });
    const head = new Endpoint({ epoch: 'h:1' });
    const { deliveredB, toA, toB } = link(tentacle, head);
    toB(tentacle.onConnected(0));
    toA(head.onConnected(0));
    tentacle.onDisconnected(1);
    head.onDisconnected(1);
    tentacle.send(enc.encode('m1'));
    tentacle.onConnected(2);
    // The head's HELLO arrives; the resume resend it triggers is lost.
    for (const bytes of transmits(head.onConnected(2))) tentacle.onBytes(bytes, 2);
    expect(deliveredB).toEqual([]);
    // After a quiet interval the tentacle's bounded repair timer resends.
    toB(tentacle.onTick(2 + 15_000));
    expect(deliveredB).toEqual(['m1']);
  });
});

describe('K-298: RESET hardening', () => {
  function connected() {
    const a = new Endpoint({ epoch: 'a:1' });
    const b = new Endpoint({ epoch: 'b:1' });
    const l = link(a, b);
    l.toB(a.onConnected(0));
    l.toA(b.onConnected(0));
    l.toB(a.send(enc.encode('x1')).effects);
    return { a, b, ...l };
  }

  it('ignores a RESET with oldest=0 and does not adopt its epoch', () => {
    const { a, b, deliveredB, resetsB, toB } = connected();
    expect(b.onBytes(encodeFrame({ t: 'reset', epoch: 'evil', oldest: 0n }), 1)).toEqual([]);
    // The real peer's next HELLO must still look like a resume, not a restart
    // (adopting 'evil' would zero the cursor and re-deliver x1).
    a.onDisconnected(2);
    toB(a.onConnected(3));
    toB(a.send(enc.encode('x2')).effects);
    expect(resetsB).toEqual([]);
    expect(deliveredB).toEqual(['x1', 'x2']);
  });

  it('ignores a same-epoch RESET that jumps implausibly far ahead', () => {
    const { a, b, deliveredB, toB } = connected();
    const effects = b.onBytes(encodeFrame({ t: 'reset', epoch: 'a:1', oldest: 1n << 40n }), 1);
    expect(effects).toEqual([]);
    toB(a.send(enc.encode('x2')).effects);
    expect(deliveredB).toEqual(['x1', 'x2']);
  });

  it('still honours a large but plausible gap and a new-epoch RESET anywhere', () => {
    const { b } = connected();
    expect(b.onBytes(encodeFrame({ t: 'reset', epoch: 'a:1', oldest: 1_000_002n }), 1)).toEqual([
      { t: 'reset-inbound', fromSeq: 1_000_002n, peerEpoch: 'a:1' },
    ]);
    expect(b.onBytes(encodeFrame({ t: 'reset', epoch: 'a:2', oldest: 1n << 40n }), 1)).toEqual([
      { t: 'reset-inbound', fromSeq: 1n << 40n, peerEpoch: 'a:2' },
    ]);
  });
});

describe('K-031/K-137: a HELLO behind the retained base is answered once', () => {
  it('does not repeat the RESET resend for an in-flight hole ACK at the same cursor', () => {
    const relay = new Endpoint({
      epoch: 'relay:1',
      restore: {
        epoch: 'relay:1',
        sendSeq: '8',
        outboxBase: '6',
        outbox: [{ seq: '7', payloadB64: Buffer.from('m7').toString('base64') }],
        recvCursor: '0',
        peerEpoch: 'computer:1',
      },
    });
    relay.onConnected(1);
    const cursor2 = { recvEpoch: 'relay:1', recvCursor: 2n };
    const hello = encodeFrame({
      t: 'hello',
      epoch: 'computer:1',
      ...cursor2,
      durableSupported: false,
      maxRetentionMs: 0n,
    });
    expect(transmits(relay.onBytes(hello, 2))).toHaveLength(3); // RESET, DATA 7, RESET 9
    expect(transmits(relay.onBytes(encodeFrame({ t: 'ack', ack: 2n }), 2))).toEqual([]);
  });
});
