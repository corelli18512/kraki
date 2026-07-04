# Plan: make pulse the single reliability layer (remove per-package pending)

## Goal

Today pulse is *layered on top of* three older reliability mechanisms. That
overlap is exactly why the arm→tentacle direction feels half-done: the packages
are not symmetric. The end state you want:

- **tentacle and arm are symmetric pulse endpoints.** Neither maintains its own
  pending/queue/dedup — pulse's outbox + cursor + ack is the *only* reliability
  layer, identical in both directions.
- **head is a dumb pipe.** Once pulse guarantees end-to-end delivery, head's
  per-hop reliability (relaySeq / trackedSend / retry / pending_messages) is
  redundant. head goes back to forward-and-forget.
- pulse's neutral core stays a black box; integration just wires message-in /
  message-out per direction.

This is not a pure refactor. It shifts buffering from **head (server-side,
30-day TTL)** to **the endpoints (tentacle disk / arm localStorage)**. See
"Product decision" at the bottom — that's the one thing to confirm before we cut
head's pending.

---

## Current state (audited, with line refs)

### tentacle `relay-client.ts`
- `pendingE2eQueue` (cap 1000) — buffers producer msgs when no consumer key /
  no online consumer. Push sites: `:1972/1986/2037`; flush `:2314` on
  `device_joined`/reconnect (`:466/2341`).
- per-hop ack mirror: `lastReceivedRelaySeq`, `seenRelaySeqs`, `withAck()`
  (`:2087`), dedup (`:2099`). This is the tentacle↔head hop ack — **not** end to
  end.
- Pulse today: reliable producer types diverted in `send()` →
  `sendReliableViaPulse()`; per-device endpoints; snapshots on disk. ✅ done.

### arm `encryption.ts` / `transport.ts`
- `encryptedQueue` (`encryption.ts:20`) — buffers *inbound* envelopes that
  arrive before the keystore/deviceId is ready; drained `:186`.
- per-hop ack mirror in `transport.ts`: `lastReceivedRelaySeq`,
  `seenRelaySeqs`, `withAck()` (`:370`), dedup (`:382`).
- Pulse today: **receive path only** (`tryPulseFrame`). Outbound consumer msgs
  (approve/answer/send_input) still go direct via `sendEncrypted`. ❌ the gap.

### head `server.ts`
- `relaySeq` per-hop delivery: `trackedSend()` (`:283`) stamps + buffers in
  `inFlight` (cap `MAX_IN_FLIGHT=200`, `:138`), retries every
  `RETRY_AFTER_MS=5000` (`:140`) × `MAX_RETRIES`, evicts oldest on overflow.
- `pending_messages` (SQLite) — offline unicast queue, 200/device, 30-day TTL.
- These give per-hop reliability that pulse now provides end-to-end.

---

## Change plan

### Phase 1 — Close the arm→tentacle gap (symmetry). LOW risk, do first.

This alone fixes "approve tapped during reconnect is lost" without touching head
or deleting anything. It just makes the arm *send* through pulse like it already
*receives* through pulse.

**Key finding from the code — the current behavior is an optimistic LIE, not
just a missing feature.** `commands.approve()` (`commands.ts:133`) does
fire-and-forget `send()` then *immediately* `removePermission` + stamps the chat
message green ("approved") — regardless of whether the send reached anyone. Tap
approve with the socket down → UI says "approved", message vanishes, agent hangs
forever, user has no idea. `sendInput` is slightly better (it uses a
`pending_input` placeholder + `clientId` resolved on echo, `commands.ts:56-85`)
but still never surfaces a *failure*.

**The model (your call): send → await pulse ack → timeout ⇒ mark failed + retry.**
Different from tentacle→arm on purpose:
- **arm→tentacle** has a live human → timeout ⇒ UI "failed, tap to retry".
- **tentacle→arm** has no human but has disk (`messages.jsonl` + pull-replay) →
  never needs a failure UI; pulse heals live, replay heals long outages.
Same pulse mechanism both ways (symmetric); only the *post-failure policy*
differs, and that policy lives in the app layer, not pulse.

**Core addition needed (small, neutral):** the Endpoint prunes its outbox on ack
(`outboxBase` advances, `endpoint.ts:229`) but exposes NO hook for "seq N is now
acked." The arm can't learn its approve was confirmed. Add a neutral
`onAck(seq)` observation to the core (it already computes the ack floor; just
surface it). This is the one change to the black box — and it's still pure
(no I/O), just an emitted signal.

Steps:

1. **pulse core**: add an `acked` effect (or an `onAcked?(seqUpTo)` callback in
   `EndpointOptions`) emitted when `outboxBase` advances. Neutral, tested in the
   pulse suite. Retry reuses the SAME seq (already how resend works) so
   exactly-once holds — an approve whose ack was lost but message arrived is not
   re-executed.
2. **arm `commands.ts`**: stop the optimistic lie. `approve/deny/alwaysAllow/
   answer/sendInput` become: optimistically show **"sending"** (not "approved"),
   route through `pulse.send(targetTentacleDeviceId, msg)`, and register the
   returned seq with a pending-send tracker.
3. **arm pending-send tracker** (new, small): `Map<seq, {sessionId, kind, ...}>`.
   On pulse `onAck(seq)` → resolve → stamp the real outcome (green "approved").
   On timeout (e.g. 10s no ack) → mark the chat message **failed** with a retry
   affordance. Retry re-invokes the same command (pulse resends same seq).
4. **target device id**: from the session's `deviceId` (same lookup
   `encryptOutbound` already does for unicast, `encryption.ts:73-76`).
5. **tentacle inbound**: already feeds pulse frames → `deliver` →
   `handleConsumerMessage` (integration commit). Verify live for approve/answer.
6. **Idempotency (safety-critical)**: confirm the tentacle no-ops an approve for
   an already-resolved permission id (so a resend after a lost ack can't
   double-apply). Audit `handleConsumerMessage` + `makePermissionHandler`; add an
   id guard if missing.
7. **Tests**: (a) pulse-core ack-observation unit test; (b) integration
   "approve tapped while arm socket is down → delivered exactly once on
   reconnect, UI clears from sending→approved"; (c) "approve that never reaches
   anyone → UI shows failed after timeout, retry succeeds."

**After phase 1**: both directions symmetric through pulse; the optimistic lie is
gone; a failed approve is visible + retryable. Nothing deleted yet.


### Phase 2 — Retire the per-package pending queues. MEDIUM risk.

Now that pulse owns reliability both ways, the endpoint-local queues are dead
weight and can cause double-delivery ambiguity. Remove them:

5. **tentacle**: delete `pendingE2eQueue` + `flushE2eQueue` (`:69, :466, :1972,
   :1986, :2037, :2314, :2341`). Reliable types are in the pulse outbox already;
   a device that connects later resumes via pulse HELLO/cursor. The only thing
   to preserve: when a brand-new device appears, its pulse endpoint starts at
   cursor 0 and pulls the outbox — verify `onConnected` on `device_joined`
   triggers the resend (it does, `:459`).
6. **arm**: `encryptedQueue` is subtler — it buffers *inbound* frames before the
   keystore is ready, which is a real pre-crypto race, not a reliability queue.
   Keep it, OR fold it into pulse by feeding late-ready frames to `onBytes` once
   ready. Recommendation: **keep** `encryptedQueue` for now — it's a
   crypto-readiness buffer, orthogonal to pulse's delivery guarantee. Note it in
   the plan so we don't mistake it for redundant.

### Phase 3 — Thin head back to a dumb pipe. HIGHER risk, gated on product call.

7. **head**: remove `trackedSend` retry/inFlight (`:283, :301`) and the
   `relaySeq` stamping — forward broadcast/unicast opaquely. Keep only:
   auth, presence (device_joined/left), pairing, and blob forwarding.
8. **head**: remove `pending_messages` (SQLite offline queue) + its 30-day TTL.
   Offline delivery becomes: pulse outbox on the sender resends on reconnect.
9. **clients**: remove the per-hop `relaySeq`/`withAck`/`seenRelaySeqs` mirrors
   in tentacle (`:2087, :2099`) and arm transport (`:370, :382`) — they only
   ever protected the per-hop, which pulse now subsumes end-to-end.
10. **Update SECURITY.md / ARCHITECTURE.md**: head no longer stores
    `pending_messages`; note the buffering moved to endpoints.

---

## Product decision to confirm BEFORE phase 3

Deleting head's `pending_messages` moves offline buffering from the **server**
(30-day TTL, survives client restarts) to the **sending endpoint's outbox**:

- **tentacle→arm**: fine — tentacle is a laptop with disk; outbox persists.
- **arm→tentacle**: your phone must now hold un-acked approves/inputs in
  localStorage until the tentacle reconnects. If the tentacle is offline for
  days, the phone carries that buffer. Bounded + TTL needed on the pulse outbox.

This is the "thin head vs fat head" fork again. Phase 1+2 don't require deciding
it. Phase 3 does.

## Suggested sequencing

- **Phase 1** now (fixes the real user-facing gap, low risk, reversible).
- **Phase 2** right after (removes tentacle queue; keep arm crypto buffer).
- **Phase 3** only after you confirm thin-head + soak pulse behind the flag in
  real use. It's the irreversible one.

## Out of scope / keep

- Durable session replay (`messages.jsonl` + `request_session_messages`) — stays.
  pulse heals live tail-loss; full history is still SessionManager's job.
- E2E crypto, auth, pairing, presence — untouched.
- pulse neutral core — untouched; this is all integration-layer.
