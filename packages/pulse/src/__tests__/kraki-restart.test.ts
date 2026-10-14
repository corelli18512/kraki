/**
 * Pin the relay-restart seq-collision bug (definitive).
 *
 * Sequence matching the dev-stack repro:
 *   RUN 1: A sends 3 non-durable frames to B. B delivers all 3 (recvCursor=3).
 *          (No durable send ⇒ snapshot never persists sendSeq ⇒ it stays 0 on disk.)
 *   CRASH: A "restarts" — restore from a durable-only snapshot whose sendSeq
 *          was last persisted BEFORE the 3 sends (= 0). A's epoch unchanged
 *          (relay persists its own epoch in the snapshot).
 *   RUN 2: A & B reconnect. Epochs MATCH (A kept old epoch), so B does NOT
 *          reset recvCursor — it stays 3. A sends a fresh frame ⇒ A assigns
 *          seq = sendSeq+1 = 1. B sees seq=1 ≤ recvCursor=3 ⇒ DUPLICATE ⇒
 *          acked but NOT delivered.
 *
 * The payload is silently dropped — exactly the device_joined loss observed.
 */
import { expect, test } from 'vitest';
import { Endpoint } from '../endpoint.js';
import type { Snapshot } from '../types.js';

function txs(
  effs:
    | ReturnType<Endpoint['send']>['effects']
    | ReturnType<Endpoint['onConnected']>
    | ReturnType<Endpoint['onBytes']>,
): Uint8Array[] {
  return effs
    .filter((e) => e.t === 'transmit')
    .map((e) => (e.t === 'transmit' ? e.bytes : new Uint8Array()));
}

test('relay-restart seq collision: non-durable sends lost ⇒ post-restart frame treated as duplicate', () => {
  const EPOCH_A = 'relay:1';
  const EPOCH_B = 'tentacle:1';

  // ── RUN 1 ──
  let A = new Endpoint({ epoch: EPOCH_A, durable: { supported: true } });
  const B = new Endpoint({ epoch: EPOCH_B, durable: { supported: false } });

  // connect
  for (const b of txs(A.onConnected(1)))
    for (const e of B.onBytes(b, 1)) {
      void e;
    }
  for (const a of txs(B.onConnected(1)))
    for (const e of A.onBytes(a, 1)) {
      void e;
    }
  // A sends 3 non-durable frames; B delivers
  let delivered = 0;
  for (let i = 1; i <= 3; i++) {
    const { effects } = A.send(new Uint8Array([i]), { durable: false });
    for (const b of txs(effects))
      for (const e of B.onBytes(b, 1)) if (e.t === 'deliver') delivered++;
  }
  expect(delivered).toBe(3);
  // B's recvCursor is now 3
  expect((B as unknown as { recvCursor: bigint }).recvCursor).toBe(3n);

  // Persist A via snapshotDurable — note sendSeq is NOT advanced here because
  // snapshotDurable was last invoked before any send (simulating "non-durable
  // sends never triggered a snapshot save"). We simulate the on-disk staleness
  // by hand: the snapshot A restores from on restart has sendSeq=0.
  const staleSnap: Snapshot = {
    epoch: EPOCH_A, // relay persists its own epoch (but the fix ignores this on restore)
    sendSeq: '0', // STALE: last persisted before the 3 non-durable sends
    outboxBase: '0',
    recvCursor: '0',
    peerEpoch: EPOCH_B, // relay had learned B's epoch
    outbox: [],
    disconnectedAtMs: null,
  };

  // ── CRASH + RESTART ──
  // A restarts with a FRESH epoch (EPOCH_A2). The fix: loadSnapshot ignores
  // the snapshot's epoch field and keeps the freshly-generated one, so the
  // peer learns the stream identity changed and resets its recvCursor.
  const EPOCH_A2 = 'relay:2';
  A = new Endpoint({ epoch: EPOCH_A2, durable: { supported: true }, restore: staleSnap });
  // A.sendSeq restored to 0 from the stale snapshot; A.epoch stays EPOCH_A2.

  // ── RUN 2: reconnect ──
  // B is the SAME long-lived object (recvCursor=3, peerEpoch=EPOCH_A).
  let bResets = 0;
  for (const b of txs(A.onConnected(100)))
    for (const e of B.onBytes(b, 101)) {
      if (e.t === 'reset-inbound') bResets++;
    }
  for (const a of txs(B.onConnected(101)))
    for (const e of A.onBytes(a, 102)) {
      void e;
    }

  // B MUST have seen the epoch change and reset its inbound stream.
  expect(bResets).toBe(1);

  // A sends a fresh frame (the device_joined). A assigns seq = sendSeq+1 = 1.
  delivered = 0;
  const { effects } = A.send(new Uint8Array([99]), { durable: false });
  for (const b of txs(effects))
    for (const e of B.onBytes(b, 200)) if (e.t === 'deliver') delivered++;

  // With the fix: B reset recvCursor on seeing the new epoch, so seq=1 is now
  // the expected next frame and IS delivered (no longer treated as a dup).
  expect(delivered).toBe(1);
});
