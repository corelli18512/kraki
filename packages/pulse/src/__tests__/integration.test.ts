/**
 * Integration smoke — two PulseSockets over a REAL localhost WebSocket, with a
 * fault-injecting relay in the middle that genuinely drops frames and kills
 * sockets mid-stream. This complements the virtual-clock harness: it proves the
 * adapter wires the pure core to real I/O correctly and that self-heal works
 * over an actual socket, not just a simulated channel.
 *
 * Kept intentionally small (spec §ops): the exhaustive matrix lives in the fast
 * deterministic scenarios; this is the "the wires are connected" proof.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { PulseSocket, type RawLink } from '../adapter-ws.js';

/** Wrap a Node `ws` WebSocket as a RawLink. */
function nodeLink(ws: WebSocket): RawLink {
  ws.binaryType = 'arraybuffer';
  return {
    send: (bytes) => ws.send(bytes),
    close: () => ws.close(),
    onOpen: (cb) => ws.on('open', cb),
    onMessage: (cb) =>
      ws.on('message', (data: ArrayBuffer | Buffer) => {
        const u = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
        cb(u);
      }),
    onClose: (cb) => ws.on('close', () => cb()),
    onError: (cb) => ws.on('error', (e) => cb(e)),
  };
}

/**
 * A relay that forwards bytes between the two connected peers and can be told
 * to drop the next N frames in a direction or kill a peer's socket. This is the
 * real-I/O analogue of the harness FaultyChannel.
 *
 * Pairing is "the other currently-open socket" rather than a fixed index, so a
 * peer that drops and reconnects is re-paired correctly (a real relay routes by
 * identity, not connection order).
 */
class FaultyRelay {
  readonly wss: WebSocketServer;
  readonly ready: Promise<void>;
  private live: WebSocket[] = [];
  private first: WebSocket | null = null; // the "A" side, by first-seen
  private dropAtoB = 0;
  private dropBtoA = 0;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.ready = new Promise<void>((res) => this.wss.on('listening', () => res()));
    this.wss.on('connection', (ws) => {
      this.live.push(ws);
      if (this.first === null || this.first.readyState > WebSocket.OPEN) this.first = ws;
      ws.on('close', () => {
        this.live = this.live.filter((p) => p !== ws);
      });
      ws.on('message', (data: Buffer) => {
        const other = this.live.find((p) => p !== ws && p.readyState === WebSocket.OPEN);
        if (!other) return;
        const fromFirst = ws === this.first;
        if (fromFirst && this.dropAtoB > 0) {
          this.dropAtoB -= 1;
          return;
        }
        if (!fromFirst && this.dropBtoA > 0) {
          this.dropBtoA -= 1;
          return;
        }
        other.send(data);
      });
    });
  }
  dropNextAtoB(n: number): void {
    this.dropAtoB += n;
  }
  killFirst(): void {
    this.first?.terminate();
  }
  async close(): Promise<void> {
    for (const p of this.live) p.terminate();
    await new Promise<void>((res) => this.wss.close(() => res()));
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('integration: two PulseSockets over a real localhost ws', () => {
  let relay: FaultyRelay;
  let port: number;
  let a: PulseSocket;
  let b: PulseSocket;
  const gotB: number[] = [];
  const gotA: number[] = [];

  beforeEach(async () => {
    relay = new FaultyRelay(0);
    await relay.ready;
    port = (relay.wss.address() as AddressInfo).port;
    gotB.length = 0;
    gotA.length = 0;

    // Short heartbeat so tail-loss recovery is fast in the smoke test.
    const params = { heartbeatIntervalMs: 150, deadAfterMs: 400 };
    a = new PulseSocket({
      epoch: 'A',
      params,
      connect: () => nodeLink(new WebSocket(`ws://127.0.0.1:${port}`)),
      onDeliver: (_seq, p) => gotA.push(p[0] ?? -1),
    });
    b = new PulseSocket({
      epoch: 'B',
      params,
      connect: () => nodeLink(new WebSocket(`ws://127.0.0.1:${port}`)),
      onDeliver: (_seq, p) => gotB.push(p[0] ?? -1),
    });
  });

  afterEach(async () => {
    a.stop();
    b.stop();
    await relay.close();
  });

  it('delivers a simple message end to end', async () => {
    a.start();
    b.start();
    await waitFor(() => a.endpoint.link === 'connected' && b.endpoint.link === 'connected');
    a.send(new Uint8Array([7]));
    await waitFor(() => gotB.includes(7));
    expect(gotB).toContain(7);
  });

  it('recovers a dropped frame via heartbeat-driven resend (real sockets)', async () => {
    a.start();
    b.start();
    await waitFor(() => a.endpoint.link === 'connected' && b.endpoint.link === 'connected');

    relay.dropNextAtoB(1); // the wire eats the next A→B frame
    a.send(new Uint8Array([1]));
    // Give it a moment; message 1 is lost, B has nothing yet.
    await new Promise((r) => setTimeout(r, 100));
    // No further sends: only heartbeat cursor exchange can heal this (TAIL-LOSS).
    await waitFor(() => gotB.includes(1), 4000);
    expect(gotB).toEqual([1]);
  });

  it('recovers across an abrupt mid-stream socket kill', async () => {
    a.start();
    b.start();
    await waitFor(() => a.endpoint.link === 'connected' && b.endpoint.link === 'connected');
    a.send(new Uint8Array([1]));
    await waitFor(() => gotB.includes(1));

    relay.killFirst(); // kill A's socket abruptly
    a.send(new Uint8Array([2])); // produced around the kill
    a.send(new Uint8Array([3]));
    // A must reconnect and resend 2,3 exactly once.
    await waitFor(() => gotB.includes(2) && gotB.includes(3), 6000);
    expect(gotB).toEqual([1, 2, 3]);
  });
});
