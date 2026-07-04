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
Header (3 bytes):
  u8  magic   = 0xB1
  u8  version = 0x01
  u8  type    (1..5)

Primitives:
  str  = u8 length (0..255) || that many UTF-8 bytes
  blob = u32 length || that many bytes
  u64  = 8 bytes big-endian
```

| type | name | body |
|------|------|------|
| 1 | HELLO | `str epoch` · `str recvEpoch` · `u64 recvCursor` · `u8 durFlags` · `u64 maxRetentionMs` |
| 2 | DATA | `u8 msgFlags` · `u64 seq` · `u64 ack` · `blob payload` |
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

This tells us how much of **our outbound** the peer has. Two checks:

```
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
| RESTART-FRESH | producer restarts with no state (new epoch) | peer's stale-epoch resume ⇒ `RESET` ⇒ `ResetInbound` (explicit) |
| TOO-OLD | consumer resumes past producer's pruned base | `RESET{oldest}` ⇒ `ResetInbound(oldest)`; gap surfaced, never hidden |
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
- It does not know message *types*, *sessions*, or *identities* — one flat seq
  stream per direction. Multiplexing/routing is the caller's job above pulse.
- It does not persist. The core holds outbox/cursor in memory; **durability
  across process restart is an adapter capability** — the adapter snapshots
  (`epoch`, `outbox`, `outboxBase`, `sendSeq`, `recvCursor`, `peerEpoch`) and
  restores it before the first input. The core's guarantee is loss-free resume
  across *reconnects within a run*; restart-durability is opt-in via the
  snapshot API.
- It does not authenticate or pair. Establishing *which* peer is on the link is
  done before pulse sees any bytes.
```
