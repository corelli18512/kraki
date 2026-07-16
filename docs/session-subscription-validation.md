# Session Subscription / Fanout Validation

Date: 2026-07-15  
Worktree: `/Users/corelli/Documents/Repos/kraki-session-subscription-validation`  
Branch: `arch/session-subscription-validation`  
Current base after rebase: `9848c4822c423763b02ca824cc86a473efd02e5b` (`v0.29.16`)  
Pulse: `@coinfra/pulse 0.4.1`

This worktree remains isolated from the main checkout and running Tentacle processes. No daemon, relay, deployment, or production state was changed.

The authoritative protocol proposal is:

- `docs/session-subscription-protocol-proposal.zh-CN.md`

## Implementation status

The protocol is implemented end to end for Protocol, Head, Tentacle, and Web in this isolated worktree. iOS was intentionally excluded from this implementation pass.

Implemented behavior includes:

- `MulticastEnvelope` with explicit target sets; Head validates, deduplicates, caps at 64 targets, and remains session/content blind.
- Head role filtering so app delivery does not fan out to sibling Tentacles.
- Head-bound `dispatch_push`, independent of online live recipients.
- Tentacle `currentSessionByArm` single-session subscription authority.
- Atomic subscribe/replace/unsubscribe ACKs with digest, spine head, and current live-card snapshot.
- Subscriber-only `agent_message_delta` and `card_action` multicast.
- Global low-frequency `session_list`, final spine messages, and runtime state.
- Removal of generic offline delta/card replay and device-join card snapshot duplication.
- Web `SessionSubscriptionController` with desired/confirmed/in-flight state, reconnect barrier, stale live-frame gating, and independent `liveReady`/spine recovery.
- Stable permission/question attention timestamps through `session_list.preview`.
- A separate `SessionManager.markUnread()` rollback path; the previous implementation incorrectly called monotonic `markRead()` and could never move `readSeq` backwards.

## Current conclusion

Kraki should use:

```text
one current session subscription per Arm
+ Head-blind opaque device multicast
+ Pulse stream 0 for live/control
+ Pulse stream 1 for bulk recovery
+ subscribe-time runtime/card snapshot
+ independent spine/TRACE/attachment recovery
+ existing session_list.preview for online attention
+ independent offline push dispatch
```

Subscription is an interest filter for the high-frequency live data plane. It does not replace the four recovery authorities:

| Axis | Authority |
|---|---|
| Persistent spine | `messages.jsonl` + per-session seq/range fetch |
| TRACE | `trace.jsonl` + `request_turn_trace` |
| Live card/draft | `CardManager` snapshot returned by subscription ACK |
| Runtime/sidebar | `SessionDigest` / `session_list` |

## Pulse 0.4 rebase update

The validation branch was rebased from `f64ddc2f` (`v0.29.15`) to `9848c482` (`v0.29.16`) after Pulse multi-stream landed.

Pulse 0.4 adds two independent reliable streams:

```text
stream 0 = live/control
stream 1 = bulk/history/TRACE/attachment
```

Each stream has its own:

```text
epoch
seq/ack
outbox
recvCursor
repair/reset
```

This eliminates bulk-to-live head-of-line blocking. It does not reduce recipient fanout and does not replace session subscriptions or multicast.

### Required subscription stream placement

Stream 0:

```text
session_list barrier
set_session_subscription
session_subscription_set + runtime/card snapshot
agent_message_delta
card_action
all Arm commands
```

Stream 1:

```text
session_messages_batch
session_messages_range_batch
turn_trace_batch
attachment_data
```

There is no cross-stream ordering guarantee. A subscription ACK on stream 0 therefore establishes `liveReady` immediately; any spine range reconciliation continues independently on stream 1 and establishes `spineReady` later.

### Routing target retention

Pulse 0.4 already fixes the previously characterized Tentacle unicast repair bug by storing targets per:

```text
(streamId, seq)
```

The old validation test expecting repair to lose the target was removed after rebase. Upstream tests now verify both live and bulk target retention.

Opaque multicast should extend the same sender-side map from:

```ts
Map<streamId, Map<seq, deviceId>>
```

to:

```ts
Map<streamId, Map<seq, DeliveryTarget>>
```

where `DeliveryTarget` can be unicast, multicast, or legacy broadcast.

Head does not need a second per-seq routing registry. Pulse hole repair retransmits the missing DATA as a separate frame; the sender reattaches the correct outer target/target-set. Head validates the current envelope and forwards the payload onto the same destination stream.

### Platform status

- Head: Pulse 0.4 live/bulk implemented.
- Tentacle: Pulse 0.4 live/bulk implemented.
- Web: Pulse 0.4 live/bulk implemented.
- iOS mainline: still uses its existing raw WebSocket queue and has not adopted the new `StreamSet` model in this release.

Because the new subscription protocol intentionally does not support mixed protocol versions, iOS must adopt Pulse 0.4 live/bulk before or as part of implementing the subscription protocol.

## Resource measurements

### E2E recipient scaling

Script: `scripts/validate-e2e-recipient-scaling.ts`

Payload: one 256-byte `agent_message_delta`, real RSA-4096/AES implementation.

| Recipients | Encrypted `{blob,keys}` size | Representative p50 encryption |
|---:|---:|---:|
| 1 | ~1.2 KB | ~0.07 ms |
| 8 | ~6.1 KB | ~0.48 ms |
| 16 | ~11.6 KB | ~1.0 ms |
| 32 | ~22.8 KB | ~2–3 ms |
| 64 | ~45.0 KB | ~4 ms |

Wire size and recipient key work scale linearly. Pulse streams do not change this scaling.

### Head fanout scaling

Script: `scripts/validate-fanout.ts`

100 state-covering delta sends with online targets:

| Online targets | Head transport transmissions |
|---:|---:|
| 1 | 110 |
| 2 | 215 |
| 4 | 425 |
| 8 | 845 |
| 16 | 1,685 |
| 32 | 3,365 |

Pulse 0.4 creates live and bulk endpoints/handshake traffic per device, so the constant baseline is slightly higher than the v0.29.15 measurement. The business fanout slope is unchanged and remains effectively:

```text
source messages × destination devices
```

Pulse 0.4 prevents bulk traffic from blocking live traffic, but every unnecessary destination still creates destination endpoint, encryption/decryption, and network work.

## Engineering issues found and resolved during implementation

### 1. Legacy Head broadcast crossed device roles

Resolved: broadcast targets are app-role devices only, while the new multicast path always uses Tentacle-selected explicit app targets.

### 2. Push preview was skipped when every Arm was offline

Resolved: push dispatch is independent of the live-recipient set and uses encrypted `dispatch_push` through the Head self-channel.

### 3. Card reconnect recovery was duplicated

Resolved: transient `agent_message_delta` and `card_action` no longer enter a generic offline queue, and device join no longer pushes all active-card snapshots. The subscription ACK snapshot is the bounded card/draft recovery authority.

### 4. `mark_unread` could not roll read state backwards

Resolved: `SessionManager.markRead()` intentionally remains monotonic, while the new idempotent `markUnread()` lowers the cursor to at most `lastSeq - 1` without ever advancing an already-unread cursor.

## Attention decision

No `SessionAttentionMessage` is needed.

Existing wire authority:

```text
session_list.payload.sessions[].preview
```

`SessionPreviewDigest.type` already supports:

```text
permission
question
```

When a permission/question opens or resolves, Tentacle updates the relevant digest preview and sends the existing low-frequency `session_list` globally on stream 0.

Pending preview must retain a stable `openedAt` timestamp; rebuilding `session_list` must not assign a new current time, or a long-running pending prompt will repeatedly jump to the top of the sidebar.

Offline attention remains independent push dispatch.

## Protocol shape after review

```ts
interface SetSessionSubscriptionMessage {
  type: 'set_session_subscription';
  payload: {
    sessionId: string | null;
  };
}
```

```ts
interface SessionSubscriptionSetMessage {
  type: 'session_subscription_set';
  payload:
    | {
        accepted: true;
        sessionId: string;
        snapshot: SessionLiveSnapshot;
      }
    | {
        accepted: true;
        sessionId: null;
        snapshot: null;
      }
    | {
        accepted: false;
        sessionId: string;
        error: {
          code: 'session_not_found';
          message: string;
        };
      };
}
```

Removed from the proposal:

```text
capability negotiation
mixed-version compatibility
multiple simultaneous session subscriptions
targetDeviceId inside the encrypted request
subscription epoch
generation
SessionAttentionMessage
session_digest_updated
```

## Final validation

All validation was run from the isolated worktree without touching the main checkout, iOS, or existing Tentacle processes.

Build and static checks:

- Protocol build: passed.
- Crypto build: passed.
- Head build/tests: passed.
- Tentacle build: passed.
- Web production build: passed.
- Workspace Biome lint: passed.
- `git diff --check`: passed.

Full unit/integration suites:

- Head: `243/243` passed.
- Tentacle: `738/738` passed.
- Web: `390/390` passed.

Real dev-stack Playwright (`real browser Arm ⇄ real Head ⇄ real Tentacle`):

- Entire project: `36/36` passed.
- Subscription/multicast scenarios: `9/9` passed.
- Covered snapshot seeding, non-subscriber isolation, atomic A→B, rapid A→B→C coalescing, refresh re-subscription, unsubscribe on leaving detail, global sidebar attention, bulk/live concurrency, and two Arms subscribed to different sessions.
- Existing conversation, question, permission, reconnect, delete, presence, preferences, pin/unread/rename metadata, history range, attachment pulls, image pulls, TRACE flood, coalescing, multi-stream reconnect, and terminal-card scenarios also passed.

## Implementation and validation files

- `packages/protocol/src/messages.ts`
- `packages/head/src/pulse-hub.ts`
- `packages/head/src/server.ts`
- `packages/tentacle/src/relay-client.ts`
- `packages/tentacle/src/tentacle-pulse.ts`
- `packages/tentacle/src/session-manager.ts`
- `packages/arm/web/src/lib/session-subscription.ts`
- `packages/arm/web/src/lib/session-subscription-lifecycle.ts`
- `packages/arm/web/src/lib/ws-client.ts`
- `packages/arm/web/src/pages/SessionPage.tsx`
- `packages/arm/web/e2e/real-stack/session-subscription.spec.ts`
- `scripts/pulse-realstack-server.ts`
- `scripts/validate-e2e-recipient-scaling.ts`
- `scripts/validate-fanout.ts`
- `docs/session-subscription-protocol-proposal.zh-CN.md`
- `docs/session-subscription-validation.md`
