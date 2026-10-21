# @coinfra/pulse

## 0.5.2

### Patch Changes

- Resume correctly after a restart from a durable-only snapshot. When a peer
  resumes against an old epoch (or is behind the outbox base), the RESET now
  announces the first seq this endpoint can actually deliver — the oldest
  retained entry, or `sendSeq + 1` when nothing is retained — instead of
  `outboxBase + 1`. After a restart `sendSeq` is ahead of the base (non-durable
  sends since the last snapshot are gone), so the peer waited for a seq that
  never came, held every later frame as a hole, and — once a stale piggybacked
  ack from its previous connection had advanced the base — had its repair ACKs
  ignored as stale. A relay restart left a computer deaf to all relay control
  this way.
- A RESET naming an epoch the receiver has not seen now replaces the receive
  cursor (it belongs to the peer's previous stream) instead of only raising it,
  so a RESET that arrives before the new epoch's HELLO no longer makes the new
  stream's frames look like duplicates. Same change in SwiftPulse.

## 0.5.1

### Patch Changes

- 8bacc16: Do not resend in-flight frames on a congested link. A heartbeat whose cursor
  lags `sendSeq` but has advanced within the last heartbeat interval now means
  "data still queued on the link", not loss: the repair waits until the cursor
  has stopped advancing for a full interval. Explicit ACKs (duplicate/hole
  signals) still repair immediately, and HELLO resume is unchanged. Previously
  every lagging heartbeat re-sent the entire unacknowledged suffix (and again
  every interval), multiplying traffic exactly when the link was saturated and
  starving later frames until the peer's liveness gave up. Idle tail loss now
  heals within two heartbeat intervals instead of one.

## 0.5.0

### Minor Changes

- 0363f85: Make the §11.4 GC policy total, and announce purged tail gaps.

  **`disconnectedAtMs` no longer returns null for a disconnected endpoint.** An
  endpoint starts Disconnected, but the field was only ever set on a
  `Connected → Disconnected` transition — so an endpoint that was created and
  never connected reported "never disconnected" indefinitely. The GC policy the
  spec itself recommends (`state == Disconnected && now - disconnectedAtMs > N`)
  therefore skipped it forever. That covers the two commonest cases for a
  store-and-forward hub: minting an endpoint to queue for a peer that is offline
  right now, and restoring endpoints on boot (snapshots are taken on the hot path,
  i.e. while Connected, so they persist `disconnectedAtMs: null`). Both leaked
  unboundedly in memory and on disk.

  The clock is now seeded at construction from the new optional
  `EndpointOptions.createdAtMs`, and a restore no longer overwrites that seed with
  a snapshot's null. `null` now means exactly one thing: "Connected right now".
  A persisted real disconnect time still wins over the seed, and repeated
  `onDisconnected` calls still do not advance the age.

  **A purged tail gap is now announced.** `resendFrom` emits its skip-RESET from
  the entry _following_ a gap, so a gap at the tail of sequence space — nothing
  retained above it — produced no RESET at all. The peer held the hole open and
  kept re-ACKing its stale cursor until some later unrelated send dragged it
  forward, one repair round-trip late, or never on an idle stream. This is exactly
  the shape `purgeNonDurable` creates when it drops the queued tail of an offline
  peer's outbox, i.e. the GC path above. A resend now also emits
  `RESET{oldest = sendSeq + 1}` when the highest retained seq is below `sendSeq`.

  Hosts should pass `createdAtMs` when constructing endpoints; omitting it
  defaults to 0, which keeps ages finite (measured from the epoch) and endpoints
  collectable.

## 0.4.1

### Patch Changes

- 7cf212f: Carry `streamId` on store/unstore/acked/purged effects (not just deliver), so a
  store-and-forward hub can key durable outbox entries per (device, stream, seq)
  instead of colliding across independent seq spaces (live seq=5 vs bulk seq=5).

## 0.4.0

### Minor Changes

- d5965e2: Multi-stream priority isolation (spec §13): one shared link can now carry N
  independent Pulse streams, each a full Endpoint with its own epoch / seq /
  outbox / cursor / handshake. A 1-byte `streamId` in the v2 wire header routes
  frames to the owning stream.

  This eliminates cross-stream head-of-line blocking: a bulk stream (history
  replay, turn-trace batches, attachment chunks) can no longer delay a live
  stream (echo, abort, status card) sharing the link. Each stream has its own seq
  space, so a live message is never queued behind bulk seqs. `onTick` visits
  streams in ascending id order so a low-id (live) stream's transmits emit first.

  - Wire: `encodeFrame(f, streamId)`; `streamId === 0` encodes as v1
    (byte-identical to pre-§13), `streamId > 0` as v2. `decodeFrameWithStream`
    returns `{frame, streamId}` and accepts both versions; `decodeFrame` is the
    stream-0 convenience wrapper.
  - `Endpoint` takes an optional `streamId` (default 0); single-stream usage is
    unchanged. New public `onFrame(frame, now)` lets a demuxer feed pre-decoded
    frames.
  - New `StreamSet` multiplexes endpoints on one link: `onConnected` /
    `onDisconnected` broadcast, `onBytes` demuxes by streamId, `onTick` schedules
    in ascending stream order.

  Backward compatible: stream 0 peers interoperate with pre-§13 peers unchanged.
  Using stream ids > 0 requires both peers to speak v2. TypeScript 149/149,
  Swift 85/85 (incl. a HOL-isolation test proving a live message delivers before
  20 bulk messages piled on a separate stream).

## 0.3.3

### Patch Changes

- 4c0abbb: Bound duplicate cursor repair so a burst of stale ACKs emits one RESET and retained suffix instead of amplifying into a resend storm. Retry a lost repair on the heartbeat timer, ignore regressive ACKs, and keep the TypeScript and Swift state machines aligned.

## 0.3.2

### Patch Changes

- 31ef7ec: Treat a restored endpoint as a new send-stream epoch so peers reset stale receive cursors after process restarts instead of dropping rewound non-durable sequence numbers as duplicates.

## 0.3.1

### Patch Changes

- f1eccc8: Fix: outboxBase could exceed sendSeq after a restart, permanently wedging the link

  Root cause of the 2026-07-10 kraki prod outage. When a durable-supported
  endpoint (kraki's head relay) restarted from a durable-only snapshot, its
  `sendSeq` was rewound to the last persisted durable send — but the peer
  (tentacle) did not restart and still advertised a `recvCursor` higher than
  the restored `sendSeq` (it had received non-durable messages that were lost
  in the crash). `pruneOutbox` blindly set `outboxBase = recvCursor`, racing
  it past `sendSeq`.

  On the NEXT fresh reconnect (peer recvCursor=0), the peer's seq=1..N frames
  were treated as duplicates (≤ outboxBase) and silently dropped — permanently
  wedging the link in both directions.

  Fix (two layers):

  - `pruneOutbox`: clamp `outboxBase = min(ackSeq, sendSeq)` so it can never
    exceed the highest seq we've actually sent.
  - `loadSnapshot`: defensively clamp `outboxBase = min(outboxBase, sendSeq)`
    on restore, so snapshots persisted by pre-0.3.1 versions (already
    corrupted on disk) self-heal on load instead of re-introducing the wedge.

## 0.3.0

### Minor Changes

- 74bca75: feat(pulse): send-time coalescing (`coalesceKey`) — spec §12

  New, fully backward-compatible surface for **state-covering** message streams
  (UI deltas, current-card state) where only the latest value matters:

  **API** — `send(payload, { coalesceKey })`:

  - Before appending, drops every existing outbox entry with the same
    `coalesceKey`; the new message gets a fresh seq. Dropped seqs become gaps
    the peer skips via the existing RESET-on-resend path (same mechanism as
    `purge*`) — no new consumer logic.
  - Mutually exclusive with `durable`: passing both throws
    (`coalesceKey requires durable=false`).
  - In-flight entries (transmitted, not yet ACKed) are coalesceable — downstream
    apps must treat coalesced payloads as state snapshots, not incremental
    deltas.
  - Emits an observational `purged(droppedSeqs, reason: 'coalesced:<key>')`.

  **Wire** — DATA frame gains flag bit 1 + an optional trailing `coalesceKey`
  str (≤255 UTF-8 bytes). Old decoders read the payload blob and stop, ignoring
  the trailing bytes, so old ↔ new is compatible in both directions. Frames
  without a `coalesceKey` are byte-identical to the 0.2 layout.

  **Effect** — `deliver` now carries `coalesceKey?: string` so a bridging hub
  (kraki head) can re-apply the same key when forwarding onto the next hop.

  **Snapshot** — `OutboxEntry` gains `coalesceKey?: string`; pre-0.3 snapshots
  deserialize with `coalesceKey=undefined` (no behavior change).

## 0.2.0

### Minor Changes

- 8298a67: feat(pulse): host-driven outbox lifecycle (GC) — spec §11

  New surface, all backward-compatible:

  **Introspection getters** — let a host key GC decisions on outbox state:
  `outboxByteSize`, `durableCount`, `nonDurableCount`, `oldestSentAt`,
  `disconnectedAtMs` (public; preserved across snapshot/restore).

  **Purge APIs** — the host's escape hatch when the peer is permanently gone
  (revoked device, closed tab, hub churn artifact):

  - `purge(predicate, reason)` — drops entries matching predicate; emits
    `unstore(seqUpTo)` for any dropped durables and observational
    `purged(droppedSeqs, reason)`.
  - `purgeNonDurable(reason='gc')` — common-case convenience.

  **Snapshot separation** — fixes a spec violation:

  - `snapshot()` unchanged (all outbox, back-compat).
  - `snapshotDurable()` new: only durable entries. This is the spec-correct
    form for restart-persistence; non-durables are "in-memory only, may be
    lost on restart" (§8.1) so persisting them both breaks the contract AND
    causes unbounded memory growth if the host writes snapshots aggressively
    (each save duplicates the same in-memory outbox into a growing disk state
    — the exact root cause of the kraki head OOM discovered on 2026-07-07).

  **Sparse outbox is now allowed.** After `purge` or restore from
  `snapshotDurable`, the outbox may contain holes in seq space. `resendFrom`
  walks entries in seq order and emits `RESET{oldest = e.seq}` before any
  entry not contiguous with the previous one, so the peer's `recvCursor`
  skips the purged range and delivery of surviving entries continues in
  order, exactly once.

  **disconnectedAtMs tracking**: recorded on Connected→Disconnected
  transition, NOT reset by repeated `onDisconnected` (adapter idempotency),
  cleared to null on reconnect, preserved across snapshot/restore. Lets a
  host GC policy safely key on "peer offline continuously for N ms".

  **Spec adds §11 "Host-driven outbox lifecycle (GC)"** + two new failure
  catalog rows: `GC-NON-DURABLE` and `SPARSE-RESUME`.

  **Test coverage**:

  - TS: 115 tests (was 93; 22 new gc tests)
  - Swift: 64 tests (was 48; 16 new gc tests)
  - Byte-identical wire behavior; existing DURABLE / SCENARIO / SLOW-NETWORK
    / PROPERTY / INTEGRATION suites unchanged.

  No breaking changes: existing hosts that never call the new APIs behave
  identically to 0.1.x.

## 0.1.2

### Patch Changes

- 299abab: fix(pulse): peer cold-restart (new epoch) now resets receive cursor

  When a peer cold-restarts (fresh epoch, no restored state, sendSeq back to 1),
  its next HELLO advertises a new `epoch` while our `recvCursor` still points at
  the old stream's tail. Without dropping our stale cursor, the peer's fresh
  seq=1..N frames matched onData's duplicate check (`f.seq <= recvCursor`) and
  were silently dropped as duplicates — the peer's new stream never delivered
  until the connection was fully reset.

  Now `onHello` detects `peerEpoch != ''` && `f.epoch != peerEpoch` (peer
  cold-restart), sets `recvCursor = 0`, and emits `ResetInbound(1, newEpoch)`
  so the application learns history was dropped. Peer's new stream is then
  accepted from seq=1 as expected by the RESTART-FRESH row in spec §9.

  Scenario in the wild: kraki daemon restart with an arm session still open —
  arm collected no fresh device_greeting / device_joined until the arm tab was
  hard-reloaded. TS + Swift ports both updated; spec §5.3 gains an explicit
  "check (0)" for the peer-restart case; test coverage added to both ports.

## 0.1.1

### Patch Changes

- ed3229d: Ship a dual ESM + CJS build. The package now exposes a `require` entry
  (`dist/index.cjs`) alongside the ESM `dist/index.mjs`, so CJS-first resolvers —
  notably tsx's tsconfig-paths resolver, used by consuming apps that run TypeScript
  sources directly — can resolve the package. Without the CJS entry, those apps
  fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Runtime behavior is unchanged.

## 0.1.0

### Minor Changes

- Initial release: reliable-delivery contract for a breakable WebSocket channel —
  message sequencing, acks, cursor-based resume, and durable outbox. Sans-I/O core
  (bring your own transport + storage), byte-identical TypeScript + Swift ports
  sharing wire fixtures.
