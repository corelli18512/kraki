# @kraki/pulse

**The delivery contract: message sequencing, acks, and cursor-based resume for a
breakable WebSocket channel. Pure logic, no I/O.**

Pulse guarantees that opaque payload bytes moved between two peers arrive
intact, in order, exactly once — or that loss is made *explicit*. It solves the
problem raw WebSocket does not: **messages lost in the seam between
connections**, and **detecting that a connection has silently died** (the
half-open / mobile-handoff case).

Pulse assumes **no application context**. It does not know what a session,
device, message type, user, or approval is — one flat sequence stream per
direction, carrying bytes it never inspects. Multiplexing, identity, auth,
pairing, and encryption all live *above* pulse. Every Kraki client (the Node
tentacle, the web arm, the iOS arm) speaks pulse; each supplies its own
transport and storage.

## Layout

```
spec/         the single source of truth (language-neutral)
  PROTOCOL.md   wire format + state machine + failure catalog (§9)
  FIXTURES.md   byte-exact frame encodings, explained
fixtures/
  wire.json     machine-readable fixtures — loaded by BOTH test suites
ts/           TypeScript implementation (npm: @kraki/pulse)
swift/        Swift implementation (SwiftPM: Pulse)
```

The two implementations are derived from `spec/` and MUST agree byte-for-byte on
the wire. That agreement is enforced by both test suites loading the same
`fixtures/wire.json` and asserting exact bytes — so a TS producer and a Swift
consumer genuinely interoperate.

## Design in one paragraph

Each peer runs a symmetric, full-duplex **Endpoint**: a producer (assigns a
per-direction sequence number to each outbound payload, retains it in an outbox
until acknowledged, resends across reconnects) and a consumer (tracks a receive
cursor, delivers in order, deduplicates, acknowledges). The Endpoint is
**sans-I/O**: it consumes inputs (`send`, `onConnected`, `onDisconnected`,
`onBytes`, `onTick`) and emits **effects** (`transmit`, `deliver`, `open`,
`close`, `reset-inbound`) that an adapter carries out. This is why every
real-world failure is deterministically testable — feed inputs, assert effects,
no sockets or wall-clock.

The critical rule (spec §3): a payload enters the outbox **before** it is ever
transmitted, so a message produced while the socket is down is always
resendable — never silently dropped with no trace.

## Guarantees (spec §9)

Loss-free resume across reconnects; in-order, exactly-once delivery;
half-open detection via receive-timeout; backoff with full jitter and no
give-up; and — when history is genuinely gone — an explicit `reset-inbound`
instead of a silent hole.

## What it does NOT do

No encryption, no message types, no sessions, no auth, no pairing, no built-in
persistence (durability is an adapter capability via the snapshot API). Wrap it.

## Working on it

```bash
# TypeScript
pnpm --filter @kraki/pulse test      # 56 tests: wire + scenarios + real-socket smoke
pnpm --filter @kraki/pulse build

# Swift (requires a Swift toolchain)
cd swift && swift test               # 25 tests: wire conformance + scenarios

# After editing fixtures, resync the Swift copy (SwiftPM won't follow symlinks):
swift/sync-fixtures.sh
```
