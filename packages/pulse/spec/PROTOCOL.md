# Pulse Protocol Specification

> **Pulse** — the delivery contract: message sequencing, acks, and cursor-based
> resume for a message channel that can break. Pure logic, no I/O. Every
> implementation (TypeScript, Swift, …) speaks the same wire format; each
> provides its own transport and storage.

Version: **1**. Status: draft. This document is the single source of truth.
The TypeScript and Swift implementations are derived from it and MUST agree
byte-for-byte on the wire format (see `spec/FIXTURES.md`).

Pulse assumes **no** application context. It moves opaque payload bytes between
two peers and guarantees they arrive intact, in order, exactly once — or that
loss is made explicit. It does not know what a "session", "device", "message
type", "user", or "approval" is. Those are the caller's concern.

---

## 1. Model

Two peers, **A** and **B**, connected by a **link**: an ordered, reliable,
breakable byte-message channel (in practice a WebSocket). The link has exactly
two states from each peer's view: **connected** or **disconnected**.

The link guarantees, *while connected*:

- **Integrity** — a frame arrives whole or not at all (no partial frames).
- **Order** — frames arrive in the order sent.
- **Fail-stop** — if a frame cannot be delivered, the link breaks; it never
  silently drops a frame mid-stream.

This is exactly what TCP/TLS/WebSocket give you. Pulse therefore does **not**
re-implement per-frame retransmission inside a live connection — that is the
transport's job. Pulse solves the *other* problem: **messages lost in the seam
between connections**, and **detecting that a connection has silently died**.

Each peer runs one **Endpoint**. An Endpoint is **symmetric and full-duplex**:
it is simultaneously a *producer* (assigns sequence numbers to outbound
payloads, retains them until acknowledged, resends across reconnects) and a
*consumer* (tracks a receive cursor, delivers in order, deduplicates,
acknowledges). There is no client/server asymmetry in the protocol; the only
asymmetry is in *configuration* (§8).

### 1.1 Sequence spaces

There are **two independent sequence spaces**, one per direction:

- A's **outbound** space: seq assigned by A to messages A→B.
- B's **outbound** space: seq assigned by B to messages B→A.

Sequence numbers are **unsigned 64-bit integers starting at 1**. `0` is the
sentinel "nothing yet" cursor. They are strictly monotonic and contiguous
within one **epoch** (§1.2).

### 1.2 Epoch

Each Endpoint has an **epoch**: an opaque string (≤ 255 UTF-8 bytes) identifying
the current incarnation of its **outbound** log.

- An Endpoint chooses a **new** epoch whenever it starts with **no retained
  outbox** (a cold start / fresh install / cleared state).
- An Endpoint **preserves** its epoch across reconnects, and across process
  restarts *if and only if* it reloads its outbox from durable storage.

The epoch lets the peer detect that our log was reset out from under it: a
resume request against a stale epoch cannot be honored and triggers a `RESET`
(§5.4). This is the mechanism that makes "you missed too much, re-sync from
scratch" **explicit** instead of a silent hole.

Epoch generation is the **caller's** responsibility (the core takes it as
input) so the core stays pure. Any collision-resistant value works: a random
128-bit hex string, a UUID, `hostname+boottime`, etc.

---

## 2. Endpoint state

```
epoch          : string        // my outbound epoch (§1.2)
sendSeq        : u64 = 0        // highest seq I have assigned (my outbound)
outbox         : [(seq, bytes)] // assigned-but-not-yet-acked, ascending seq
outboxBase     : u64 = 0        // (lowest retained seq) - 1; 0 if nothing pruned

recvCursor     : u64 = 0        // highest CONTIGUOUS seq accepted from peer
peerEpoch      : string = ""    // epoch of the peer stream recvCursor refers to

link           : Connected | Disconnected
lastRecvAt     : Millis         // time any frame last arrived (liveness)
lastSendAt     : Millis         // time any frame was last transmitted (heartbeat)
reconnectAt    : Millis?        // when to next attempt OpenConnection
attempt        : u32 = 0        // consecutive failed-connect count (backoff)
```

`ackedSeq` (the peer's confirmed contiguous receipt of *our* outbound) is not
stored separately; it is `outboxBase` — everything ≤ `outboxBase` has been
acknowledged and pruned.

---

## 3. Effects (sans-I/O boundary)

The core performs **no I/O**. It is driven by inputs (§4) and emits **effects**
that the adapter carries out. This is what makes every real-world failure
deterministically testable: feed inputs, assert effects.

| Effect | Meaning — the adapter MUST… |
|--------|------------------------------|
| `Transmit(bytes)` | send these bytes as one message on the current link |
| `Deliver(seq, payload)` | hand this payload to the application; in order, once |
| `OpenConnection` | begin establishing the link (dial) |
| `CloseConnection` | tear down the current link (it is dead/stale) |
| `ResetInbound(fromSeq, peerEpoch)` | inbound history before `fromSeq` is unrecoverable; the application is re-synced at `fromSeq` and MUST discard assumptions about earlier peer messages (the explicit "recovered=false") |
| `Acked(seqUpTo)` | the peer has confirmed receipt of every outbound message with seq ≤ `seqUpTo`; the application may resolve "delivered" for what it sent (e.g. clear/roll back optimistic UI). Purely observational — emitting it changes no protocol behavior |
| `Store(seq, payload)` | persist this outbox entry to durable storage (survives a process restart). Emitted only by a `durableSupported` endpoint, only for messages sent with `durable: true`. The adapter writes `(seq → payload)` to disk. The core supplies **only seq and bytes** — never a destination, key, or routing hint (it has none). |
| `Unstore(seqUpTo)` | durable entries with seq ≤ `seqUpTo` are confirmed delivered (or expired) and may be deleted from durable storage. |

**Ordering contract.** When the core assigns a seq to an outbound payload
(§5.1), the `outbox` entry is created **before** any `Transmit` for it is
emitted. An adapter that persists the outbox MUST make the entry durable no
later than it transmits. This single rule closes the "message produced while the
socket was down is lost with no trace" hole: the payload is always in the outbox
(and thus resendable) before it is ever entrusted to the wire.

---

## 4. Inputs (adapter → core)

| Input | When the adapter calls it |
|-------|---------------------------|
| `send(payload) -> seq` | application wants to send an opaque payload |
| `onConnected()` | the link just became connected |
| `onDisconnected()` | the link just broke (close/error) |
| `onBytes(bytes)` | a message arrived on the link |
| `onTick(now)` | periodic clock tick (drives heartbeat, liveness, reconnect) |

`onTick` is edge-triggered by a monotonic clock. The core also exposes
`nextDeadline() -> Millis?` so an efficient scheduler can sleep exactly until the
next timer instead of polling; tests just advance a virtual clock and tick.

All randomness (jitter, §7) enters through an injected `random() -> [0,1)`
function so the core is deterministic under test.

---

## 5. Frames and behavior

### 5.0 Wire format

Binary, big-endian. One frame = one link message.

```
Header:
  u8  magic   = 0xB1
  u8  version = 0x01 (v1) or 0x02 (v2)
  u8  type    (1..5)
  [u8 streamId]        # v2 only (spec §13); absent in v1 (streamId implicit 0)

Primitives:
  str  = u8 length (0..255) || that many UTF-8 bytes
  blob = u32 length || that many bytes
  u64  = 8 bytes big-endian
```

**Version 1 vs 2.** v1 is the original single-stream header (3 bytes). v2
adds a 1-byte `streamId` after `type` (spec §13, multi-stream). v2 is emitted
**only** when `streamId > 0`; a frame on the default stream (`streamId == 0`)
is encoded as v1, byte-identical to the pre-§13 layout. Decoders accept BOTH:
a v1 frame is a v2 frame with `streamId == 0`. An old (v1-only) peer cannot
parse a v2 frame, so endpoints that actually use multiple streams must upgrade
together (the application decides when to open stream ids > 0).

| type | name | body |
|------|------|------|
| 1 | HELLO | `str epoch` · `str recvEpoch` · `u64 recvCursor` · `u8 durFlags` · `u64 maxRetentionMs` |
| 2 | DATA | `u8 msgFlags` · `u64 seq` · `u64 ack` · `blob payload` · `[str coalesceKey]` |
| 3 | ACK | `u64 ack` |
| 4 | RESET | `str epoch` · `u64 oldest` |
| 5 | HEARTBEAT | `u64 ack` |

**Flag bytes** (bitfields; all undefined bits reserved 0):

- HELLO `durFlags` bit 0 = `durableSupported` (this endpoint can persist its
  outbox across a process restart). `maxRetentionMs` is meaningful only when the
  bit is set (else 0): the longest a persisted entry is kept before it is
  abandoned. This is a pure transport capability advertised at handshake time.
- DATA `msgFlags` bit 0 = `durable` (this message must be persisted, not merely
  buffered in memory — see §8.x). The sender only sets it when the peer
  advertised `durableSupported`; otherwise it is ignored on the wire.
- DATA `msgFlags` bit 1 = `hasCoalesceKey` (§12). When set, a trailing `str`
  (the coalesce key, ≤255 UTF-8 bytes) follows the payload blob. When clear, no
  trailing field is present and the frame is byte-identical to the pre-§12
  layout. An old decoder that does not know bit 1 reads the payload blob and
  stops, silently ignoring the trailing key — harmless, because coalescing is a
  producer-side operation that has already happened on the sender's outbox.

A frame that is malformed, has the wrong magic/version, or an unknown type is
**ignored** (dropped without state change). Robustness over strictness: a future
version can add frame types without breaking v1 peers.

`ack` on DATA and HEARTBEAT is a **piggybacked cursor**: the sender's current
`recvCursor`, so the receiver can prune its outbox without a separate ACK.

### 5.1 send(payload) — producing

```
sendSeq += 1
outbox.append((sendSeq, payload))          // BEFORE any transmit (§3 ordering)
if link == Connected:
    emit Transmit(encodeDATA(seq=sendSeq, ack=recvCursor, payload))
    lastSendAt = now
return sendSeq
```

If disconnected, the payload sits in the outbox and is transmitted on resume
(§5.3). It is **never** dropped for being produced while offline.

### 5.2 onConnected — resume handshake

```
attempt = 0
reconnectAt = null
emit Transmit(encodeHELLO(epoch, recvEpoch=peerEpoch, recvCursor))
lastSendAt = now
```

Both peers send HELLO immediately. HELLO is the resume request: "I am epoch
`E`; I have contiguously received up to `recvCursor` of your epoch `peerEpoch`;
continue after that."

### 5.3 onBytes(HELLO { peerEpoch', peerRecvEpoch, peerRecvCursor })

This tells us how much of **our outbound** the peer has. Three checks:

```
# (0) Did the peer cold-restart (RESTART-FRESH, §9)?
# The peer's send-side epoch changed: any recvCursor we hold refers to a
# stream that no longer exists. Without dropping it, peer's fresh seq=1..N
# would be silently dropped by §5.3.1's duplicate check (seq <= recvCursor).
if peerEpoch != "" and peerEpoch' != peerEpoch:
    recvCursor = 0
    emit ResetInbound(fromSeq = 1, peerEpoch = peerEpoch')

# (a) Did the peer resume against an epoch we can still serve?
if peerRecvEpoch != "" and peerRecvEpoch != epoch:
    # peer is trying to resume a stream we no longer have (we cold-started)
    emit Transmit(encodeRESET(epoch, oldest = outboxBase + 1))
    # then (re)send our whole current outbox:
    resendFrom(outboxBase + 1)
    remember peerEpoch' as peerEpoch; return

# (b) Prune what the peer already has, then resend the rest.
if peerRecvCursor >= outboxBase:
    prune outbox entries with seq <= peerRecvCursor
    outboxBase = max(outboxBase, peerRecvCursor)
    resendFrom(peerRecvCursor + 1)
else:
    # peer is behind our oldest retained seq — we pruned what it needs
    emit Transmit(encodeRESET(epoch, oldest = outboxBase + 1))
    resendFrom(outboxBase + 1)

peerEpoch = peerEpoch'   // track peer's current epoch for our own next HELLO
```

`resendFrom(s)`: for each outbox entry with seq ≥ s, in ascending order,
`emit Transmit(encodeDATA(seq, ack=recvCursor, payload))`. Ordered, gap-free.

### 5.3.1 onBytes(DATA { seq, ack, payload }) — consuming

```
prune outbox by ack (peer confirms our outbound up to `ack`):
    remove outbox entries with seq <= ack; outboxBase = max(outboxBase, ack)

if seq == recvCursor + 1:                 # the expected next message
    recvCursor = seq
    emit Deliver(seq, payload)
elif seq <= recvCursor:                    # duplicate (our earlier ack was lost)
    # Do NOT re-deliver — but DO re-advertise our cursor so the sender learns we
    # already have it and stops resending. Without this, a lost ack can wedge the
    # sender resending forever and it never observes delivery. (Same rationale as
    # TCP's dup-ACK.)
    emit Transmit(encodeACK(recvCursor))
else:                                      # seq > recvCursor + 1 : a hole
    (do NOT deliver, do NOT advance)
    emit Transmit(encodeACK(recvCursor))   # tell peer to rewind and resend
lastRecvAt = now
```

Both the duplicate and hole branches re-ACK: pruning the sender's outbox
(and thus firing its `Acked` observation) requires the cursor to get back, so a
receiver that already has a message must still say so when it sees a resend.

**Exactly-once at the app boundary** is a consequence: in-order delivery advances
the cursor by one; duplicates fall in the `seq <= recvCursor` branch and are
dropped; a message is `Deliver`ed at most once.

### 5.3.2 onBytes(ACK { ack }) / onBytes(HEARTBEAT { ack })

```
prune outbox by ack (as in 5.3.1)
lastRecvAt = now
# HEARTBEAT additionally is liveness evidence (any frame is), no reply required
```

### 5.4 onBytes(RESET { peerEpoch', oldest })

The peer cannot give us everything after our `recvCursor`; its earliest
available outbound seq is `oldest`.

```
peerEpoch = peerEpoch'
if oldest > recvCursor + 1:
    # unavoidable gap: messages (recvCursor+1 .. oldest-1) are gone forever
    recvCursor = oldest - 1
    emit ResetInbound(fromSeq = oldest, peerEpoch')
# else: no gap; peer will resend from recvCursor+1 as usual (nothing to do)
```

`ResetInbound` is the honest "you missed data that no longer exists; you are
now re-synced at `oldest`." The application decides how to recover (e.g. reload
from its own source of truth). Pulse never hides the gap.

---

## 6. Liveness (half-open / silent death)

A TCP connection can black-hole: our side believes it is connected, but nothing
reaches the peer and nothing comes back (mobile handoff, NAT rebind). Pulse
detects this with a **receive-timeout**, symmetric on both peers.

On `onTick(now)` while `Connected`:

```
# 1. Send a heartbeat if we've been quiet, so the PEER's receive-timer resets.
if now - lastSendAt >= HEARTBEAT_INTERVAL_MS:
    emit Transmit(encodeHEARTBEAT(ack = recvCursor)); lastSendAt = now

# 2. Declare the link dead if WE have heard nothing for too long.
if now - lastRecvAt >= DEAD_AFTER_MS:
    emit CloseConnection            # adapter tears down; onDisconnected follows
```

Because *any* inbound frame updates `lastRecvAt`, and each side emits a
heartbeat every `HEARTBEAT_INTERVAL_MS` when otherwise idle, a healthy link
refreshes the timer roughly twice per `DEAD_AFTER_MS` window. A half-open link
trips the receive-timeout on the side that stopped hearing — which is exactly
the side that must reconnect.

`onTick` also drives heartbeat piggyback pruning: heartbeats carry `ack`, so an
idle producer still learns the consumer's cursor and an idle consumer still
advertises its cursor — **this is what closes tail-loss** (§9, TAIL-LOSS).

---

## 7. Reconnect policy

On `onDisconnected()`:

```
link = Disconnected
attempt += 1
delay = full_jitter(attempt)
reconnectAt = now + delay
```

On `onTick(now)` while `Disconnected` and `now >= reconnectAt`:

```
emit OpenConnection
reconnectAt = null        # adapter will call onConnected or onDisconnected
```

**Backoff with full jitter**, no attempt cap (retries forever — a phone in a
tunnel must recover when it emerges):

```
ceil  = min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_FACTOR^(attempt-1))
delay = floor(random() * (ceil + 1))     # full jitter: uniform in [0, ceil]
```

Full jitter (uniform in `[0, ceil]`, not `ceil ± jitter`) is what prevents a
thundering herd when many endpoints drop together and reconnect to one server.

---

## 8. Parameters

| Name | Default | Notes |
|------|---------|-------|
| `PROTOCOL_VERSION` | `1` | wire byte 1 |
| `HEARTBEAT_INTERVAL_MS` | `15_000` | send heartbeat if idle this long |
| `DEAD_AFTER_MS` | `30_000` | no inbound for this long ⇒ dead (≈ 2 heartbeats) |
| `RECONNECT_BASE_MS` | `1_000` | first backoff ceiling |
| `RECONNECT_MAX_MS` | `30_000` | backoff ceiling cap |
| `RECONNECT_FACTOR` | `2` | geometric growth |

**Asymmetric configuration solves "who reconnects first."** The protocol is
symmetric, but two peers may be configured differently. If one peer (e.g. an
always-on server) uses a *larger* `DEAD_AFTER_MS` than the other (e.g. a mobile
client), the client's receive-timeout trips first on a glitch and the client
initiates reconnect — the side that knows its own local link best — instead of
both racing. This is a deployment choice, not a protocol change. (It is the
lesson of a real prior heartbeat race: the reclaiming side should be the one
with the tighter timeout.)

## 8.1 Durable outbox (persist across restart)

Ordinary outbox entries live in memory. They survive **reconnects within one
run** (resend on resume, §5.3) but are lost if the process restarts without a
snapshot. That is the right default: most messages are only worth delivering
while the sender is alive to retry them.

Some messages must survive a **process restart** of the sender, because the
sender may go away entirely before the peer ever comes back (a mobile client
that sends, then is killed). For those, an endpoint can persist the outbox entry
to disk. This is a **transport capability**, not an application concept: the core
knows only "this entry is durable" and "my outbox can be persisted." It does not
know why, what the payload is, or where it ultimately goes.

Two independent pieces:

- **Capability (per endpoint, advertised at handshake).** An endpoint with
  `durableSupported = true` (HELLO `durFlags` bit 0) can persist its outbox. It
  advertises `maxRetentionMs` — how long a persisted entry is kept before being
  abandoned. Default endpoints advertise `false`.

- **Per-message flag (per send).** `send(payload, { durable: true })` marks one
  message. On transmit, the DATA `msgFlags` durable bit is set **only if the
  peer advertised `durableSupported`** — a durable message is pointless unless
  the receiving side can persist it. If the peer cannot, the bit is cleared and
  the message degrades to an ordinary in-memory entry (the application decides,
  via `Acked` timeout, whether that is a failure).

Behavior on a `durableSupported` endpoint:

```
# on send(payload, {durable:true}), after the outbox entry is created:
if self.durableSupported and this entry is durable:
    emit Store(seq, payload)          # adapter writes seq→bytes to disk

# on prune (peer acked seq ≤ N):
emit Unstore(N)                        # adapter deletes durable entries ≤ N

# on restore after restart:
#   the adapter reloads persisted (seq→payload) entries into the outbox
#   BEFORE the first input; resume (§5.3) then resends them normally.

# on onTick, for any durable entry older than maxRetentionMs:
#   drop it from the outbox and emit Unstore(seq); it will never be resent.
```

The core never learns a destination for a stored entry — `Store`/`Unstore`
carry only seq and bytes. "Which peer this is ultimately for, where to keep it,
how to route it after restart" is entirely the adapter's concern. This is the
line that keeps the core context-free: durability is *its own outbox persisting
itself*, not *a store forwarding to a third party*.

---

## 9. Real-world failure catalog → guaranteed behavior

Every row is a scenario the test suites (`ts/src/__tests__`,
`swift/Tests`) assert. This table is the contract.

| # | Real-world situation | Guaranteed behavior |
|---|----------------------|---------------------|
| CLEAN-DISCONNECT | link closes gracefully, reopens | outbox resends from peer's `recvCursor+1`; no loss, no dup |
| ABRUPT-KILL | socket killed mid-transmit | half-sent frame is fail-stop (never partial); resent whole on resume |
| PRODUCE-WHILE-DOWN | app calls `send` while disconnected | payload enters outbox, transmitted on resume; never dropped |
| OFFLINE-CATCHUP | consumer offline, producer keeps sending | on reconnect, consumer's HELLO cursor pulls the whole backlog in order |
| TAIL-LOSS | last N messages lost, then producer goes idle | idle heartbeats carry cursors; consumer's lagging cursor triggers resend; recovered within one heartbeat window |
| DUPLICATE | same seq delivered twice (resend overlap) | `seq <= recvCursor` ⇒ dropped; `Deliver` fires at most once |
| REORDER | frames arrive out of order (defensive) | hole (`seq > recvCursor+1`) is not delivered; ACK rewinds peer; in-order only |
| HALF-OPEN | TCP black-holed, no close event | receive-timeout (`DEAD_AFTER_MS`) ⇒ `CloseConnection` ⇒ reconnect |
| RECONNECT-STORM | many peers drop at once | full-jitter backoff spreads reconnects; no attempt cap |
| RESTART-DURABLE | producer restarts, reloads outbox+epoch | epoch preserved ⇒ resume succeeds across restart |
| RESTART-FRESH | producer restarts with no state (new epoch) | consumer sees `peerEpoch` change in HELLO ⇒ resets `recvCursor = 0` and emits `ResetInbound(1, newEpoch)`; peer's fresh seq=1..N are delivered (not dropped as duplicates) |
| TOO-OLD | consumer resumes past producer's pruned base | `RESET{oldest}` ⇒ `ResetInbound(oldest)`; gap surfaced, never hidden |
| GC-NON-DURABLE | host purges non-durable outbox entries after a long disconnect (`purgeNonDurable`) | on next resend, RESET frames are emitted before each remaining seq that isn't contiguous with the previous — peer's `recvCursor` skips over the purged range; durable entries continue to deliver in order, exactly once |
| SPARSE-RESUME | producer restores from `snapshotDurable()` (only durable outbox persisted) | sparse in-memory outbox after restore; `resendFrom` emits RESET-per-gap so the peer skips lost non-durable seqs, then delivers the surviving durables in order |
| SLOW-LINK | high one-way propagation delay | delivery is delayed by the propagation time but stays in order, exactly once; outbox drains after the ack's round trip |
| JITTER | per-frame delay varies, frames can cross | in-order, exactly-once delivery preserved; a hole waits for its predecessor |
| DEAD-TIMER-RACE | RTT approaches `DEAD_AFTER_MS` | a healthy-but-slow link whose heartbeats still arrive is NOT false-killed; a link slower than the threshold IS declared dead (correct) |
| PERIODIC-CUT | link severed on a fixed interval for minutes | reconnects every cycle and delivers everything exactly once, in order; a cut mid-flight loses the in-flight frame (fail-stop) but resends on resume |
| WEDGE-FREE | any of the above, repeatedly | endpoint always returns to Connected+drained when the peer is reachable |

> **Out of scope — censorship / DPI.** PERIODIC-CUT models a link that is
> repeatedly *reset*, which pulse survives by reconnecting. It does **not**
> model a content-inspecting or fingerprint-based blocker: such a firewall acts
> *before the first byte*, below the layer pulse operates at. Defeating it is a
> transport-obfuscation concern (TLS-fingerprint mimicry, domain fronting,
> pluggable transports) that lives beneath pulse, not inside it.

---

## 10. What Pulse does NOT do

- It does not encrypt. Payloads are opaque bytes; wrap them yourself.
- It does not know message *types*, *sessions*, or *identities*. The unit of
  delivery is one flat ordered seq stream per direction — but a single link may
  carry **multiple independent streams** (spec §13), so the application can keep
  low-latency traffic off the same ordered queue as bulk transfers. Pulse routes
  by a 1-byte `streamId` on the wire; how the application maps its messages to
  streams (and whether it uses more than the default stream 0) is above Pulse.
- It does not persist. The core holds outbox/cursor in memory; **durability
  across process restart is an adapter capability** — the adapter snapshots
  (`epoch`, `outbox`, `outboxBase`, `sendSeq`, `recvCursor`, `peerEpoch`) and
  restores it before the first input. The core's guarantee is loss-free resume
  across *reconnects within a run*; restart-durability is opt-in via the
  snapshot API.
- It does not authenticate or pair. Establishing *which* peer is on the link is
  done before pulse sees any bytes.

---

## 11. Host-driven outbox lifecycle (GC)

The core keeps every unacknowledged send in an in-memory outbox until the peer
confirms via cursor. That is correct for a peer that reconnects within seconds.
For a peer that is **permanently gone** — a revoked device, a closed browser
tab, a churn artifact in a store-and-forward hub — the outbox grows without
bound. The core cannot decide whether "silent for 10 minutes" means "on the
subway" or "user threw the phone in the lake"; that judgment is the host's.
Section §11 defines the API the core exposes to let a host make that judgment
and act on it.

### 11.1 Introspection

Pure getters on `Endpoint`, all O(N) worst case in outbox size but N is
small in practice:

```
outboxSize        # entry count
outboxByteSize    # sum of payload byteLengths  (host memory accounting)
durableCount      # entries with durable=true
nonDurableCount   # entries with durable=false
oldestSentAt      # host-clock ms of the oldest entry, or null if empty
disconnectedAtMs  # host-clock ms since when the peer has been offline, or
                  # null while Connected. Preserved across snapshot/restore.
```

`disconnectedAtMs` is an offline-since stamp. It is set on each `Connected →
Disconnected` transition (repeated `onDisconnected` calls do not reset it, so
adapter idempotency is preserved) and cleared to null on `onConnected`.

It is also **seeded at construction** from `createdAtMs`. An endpoint begins
Disconnected, so one that is created and never connected has been offline since
birth and reports that age — NOT null. This matters because the two situations
are the common ones for a store-and-forward hub: minting an endpoint to queue
for a peer that is currently offline, and restoring endpoints on boot. A
snapshot taken while Connected carries `disconnectedAtMs: null`; on restore the
endpoint is Disconnected (it has no link yet), so it keeps its construction seed
rather than adopting the null.

Together this guarantees `state == Disconnected` implies a non-null
`disconnectedAtMs`, which is what makes the GC policy in §11.4 total: a host can
key on "the peer has been continuously offline for at least N ms" without an
endpoint class that is silently exempt forever.

### 11.2 Purge

```
purge(predicate, reason='host') → {droppedSeqs, effects}
purgeNonDurable(reason='gc')    → {droppedSeqs, effects}   # convenience
```

`purge` removes outbox entries for which `predicate({seq, durable, sentAt,
byteLength})` returns true, and emits:

- `Unstore(seqUpTo = max dropped durable seq)` — if any durable entry was
  dropped, so the adapter deletes its disk copy. The adapter deletes only
  durable rows it holds with `seq ≤ seqUpTo`, so surviving durables with
  higher seqs are untouched.
- `Purged(droppedSeqs, reason)` — observational, always emitted when
  `droppedSeqs` is non-empty. `reason` is echoed from the caller for logs.

Purge does NOT rewind `outboxBase` and does NOT synthesize new peer traffic.
The peer only learns about the gap on the next resend, where `resendFrom`
walks entries in seq order and emits a `RESET{oldest = e.seq}` frame before
any entry that isn't contiguous with the previous one. The peer's `onReset`
advances `recvCursor = oldest - 1`, skipping the purged range; the next DATA
frame then delivers normally.

Those RESETs are driven by the entry that *follows* a gap, so they cannot cover
a gap at the **tail** of sequence space — the case where the dropped seqs are
the highest ones held (the outbox may even end up empty). A resend then emits
nothing at all and the peer is never told: it holds the hole open, keeps
re-ACKing its stale cursor, and is only dragged forward by a later unrelated
send — one repair round-trip late, or never on an idle stream. A tail gap is
exactly what `purgeNonDurable` produces on an offline peer. Therefore a resend
MUST also announce any tail gap, by emitting `RESET{oldest = sendSeq + 1}` when
the highest retained seq is below `sendSeq`.

This means the outbox is **allowed to be sparse** after a purge. `resendFrom`
must sort entries by seq and inject a RESET per gap. This is a change from
the original spec's implicit "outbox is a contiguous prefix"; the new rule
is "outbox is a monotonically ordered set of seqs, possibly with holes".

### 11.3 Snapshot separation

`snapshot()` (unchanged, back-compat) serializes ALL outbox entries. It is
kept as-is so pre-§11 adapters continue working.

`snapshotDurable()` (new) serializes ONLY durable outbox entries. **This is
the spec-correct form for restart-persistence.** Non-durable entries mean, by
definition, "in-memory only, may be lost on restart" (§8.1); persisting them
to disk violates that contract AND causes unbounded memory growth if the
adapter writes snapshots on every hot-path frame (each save duplicates the
same in-memory outbox into a growing on-disk representation).

On restore from `snapshotDurable()`, the outbox is sparse in seq space
(non-durable seqs are missing). `resendFrom`'s sparse-outbox handling (§11.2)
takes care of the peer-side reconciliation via RESET frames.

`sendSeq` is preserved by both snapshot forms so future sends never collide
with the dropped seqs.

### 11.4 GC policy is the host's

The core provides no default GC. A store-and-forward hub might implement,
per endpoint:

```
if endpoint.state == Disconnected
   and now - endpoint.disconnectedAtMs > 5 * 60_000:
    endpoint.purgeNonDurable(reason='gc-idle-5m')

if endpoint.state == Disconnected
   and now - endpoint.disconnectedAtMs > 24 * 3600_000:
    # durable snapshot already on disk; safe to release the entire endpoint
    deleteEndpoint(endpoint)
```

Per §11.1, `state == Disconnected` guarantees `disconnectedAtMs` is non-null, so
this policy is total — no endpoint escapes it. (Before that guarantee, hosts
writing exactly this loop leaked every never-connected and every boot-restored
endpoint, because both reported null and fell out of both branches.)

A per-tab web app might not GC at all (short-lived process, small outbox).
A mobile client might set aggressive thresholds. The core does not care —
its contract is just to make purge safe and to make the peer converge after
one.
```

## 12. Send-time coalescing (`coalesceKey`)

Pulse's default contract is a **reliable queue**: every send is retained and
replayed until acked. That is correct for events that must not be lost
(`user_message`, `agent_message`, `tool_result`). It is *wrong* for
**state-covering** streams — UI deltas, a session's current card state — where
only the latest value matters and replaying N stale frames on reconnect is pure
waste (and, at scale, a UI-freezing burst).

`coalesceKey` lets the application declare "these messages supersede each other"
without Pulse ever inspecting the payload:

```
send(payload, { coalesceKey: k }):
    assert not durable            # mutually exclusive (see below)
    droppedSeqs = [e.seq for e in outbox if e.coalesceKey == k]
    outbox = [e for e in outbox if e.coalesceKey != k]   # drop supersededs
    if droppedSeqs: emit Purged(droppedSeqs, reason='coalesced:'+k)
    sendSeq += 1
    outbox.append((sendSeq, payload, coalesceKey=k))
    if link == Connected:
        emit Transmit(encodeDATA(seq=sendSeq, ack=recvCursor, payload, coalesceKey=k))
    return sendSeq
```

**Rules**

1. **Drop-and-replace.** A send with key `k` drops every existing outbox entry
   with key `k` before appending. The new message always gets a fresh
   `sendSeq`; dropped seqs are never re-used.
2. **Dropped seqs become gaps.** The consumer sees a sparse seq stream. The
   existing resume/resend path announces each gap with a `RESET { oldest }`
   frame (identical to what `purge*` produces, §11.2), so the peer advances its
   `recvCursor` over the gap and the following DATA delivers. **No new consumer
   logic is required.**
3. **Mutually exclusive with `durable`.** `durable` = "never lose"; `coalesce` =
   "may be dropped". Requesting both is a contradiction and MUST throw. Because
   coalesceable entries are therefore never durable, coalescing emits no
   `Unstore` — nothing was ever persisted.
4. **In-flight coalescing is allowed.** An entry already transmitted but not yet
   acked can still be coalesced away. The peer may have already delivered the
   old payload to its application; the newer same-key message simply overwrites
   that state. Downstream applications MUST therefore treat a coalesced payload
   as a **state snapshot**, not an incremental delta.
5. **The hint rides the wire and the `deliver` effect.** DATA carries the key
   (flag bit 1 + trailing `str`, §5.0), and `deliver` echoes
   `coalesceKey?: string`. A store-and-forward hub can thus re-apply the same
   key when forwarding onto the next hop, so coalescing composes across a
   multi-hop path (e.g. tentacle → head → arm: the key set at the origin is
   preserved to the endpoint whose outbox actually accumulates).

**Wire / snapshot / compatibility.** DATA gains flag bit 1 and an optional
trailing `coalesceKey` str (≤255 UTF-8 bytes; §5.0). `OutboxEntry` in the
snapshot (§10) gains `coalesceKey?: string`. Both are additive: pre-§12 peers
and snapshots interoperate unchanged — an old decoder ignores the trailing key,
and a new frame without a key is byte-identical to the old layout.

---

## 13. Multi-stream (priority isolation)

A single ordered stream is a FIFO: a message produced after a burst of bulk
transfers is assigned a seq behind all of them and cannot be delivered until
they are. For traffic that is genuinely sequenced (a conversation) this is
correct. For traffic that is **independent** it is head-of-line blocking: a live
reply, an abort, or a status-card update should not wait behind a history
replay, a turn-trace batch, or an attachment chunk that happened to be sent
first.

Pulse solves this with **multiple independent streams on one shared link**.
Each stream is a full `Endpoint` — its own epoch, seq space, outbox, receive
cursor, handshake, liveness timers, durability. Streams share only the physical
link (one WebSocket); connect/disconnect events are broadcast to every stream.

### 13.1 Wire

The v2 header carries a 1-byte `streamId` (§5.0). A frame on stream 0 is
encoded as v1 (byte-identical to a pre-§13 peer); a frame on any other stream
is encoded as v2. A decoder accepts both and routes each frame to the endpoint
that owns its `streamId`. Frames for an unknown / unregistered stream are
dropped (the peer may have a stream we have not opened — harmless, like an
unknown frame type).

### 13.2 Independence

Every guarantee in §9 holds **per stream**: in-order exactly-once delivery,
resume across reconnects, restart-durability, coalescing, GC. A RESET, a
reconnect, or a coalesce on one stream does not affect any other stream's
cursor or outbox. A bulk stream can be saturated, repaired, purged, or reset
without a live stream noticing — the live stream's seq 5 is not behind the bulk
stream's seq 1..N because they are different seq spaces.

### 13.3 Scheduling

`onTick` visits streams in ascending `streamId` order, so a lower-numbered
(live) stream's `Transmit` effects are emitted before a higher-numbered (bulk)
stream's within one tick window. An adapter that flushes transmit effects in
the order Pulse returns them therefore sends live traffic first. Per-stream
independence is what closes the HOL gap: combined with the per-stream seq
space, a live transmit is never queued behind bulk seqs.

### 13.4 Application responsibility

Pulse provides the streams and the routing; it does not decide which
application message goes on which stream. A typical mapping: stream 0 = live
(user messages, agent replies, aborts, status cards, permissions/questions,
liveness heartbeats); stream 1 = bulk (history range batches, turn-trace
batches, attachment chunks). Using only stream 0 recovers the pre-§13
single-stream behavior exactly. Endpoints that use stream ids > 0 must peer
with a v2-capable endpoint (the application arranges this).
