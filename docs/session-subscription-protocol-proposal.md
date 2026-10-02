# Single Session Subscription + Opaque Multicast Protocol Proposal

**Status:** Protocol / Head / Tentacle / Web are implemented and verified on a real dev stack; iOS is out of scope for this round  
**Date:** 2026-07-15  
**Based on:** `9848c4822c423763b02ca824cc86a473efd02e5b` (workspace `v0.29.16`, Head `v0.16.5`)  
**Scope:** the authoritative protocol and implemented behavior; this implementation covers Protocol, Head, Tentacle and Web, not iOS.  
**Versioning policy:** no compatibility with old Heads, old Tentacles or old Arms; the affected components ship on the same protocol version.

---

## 1. Final model

Each Arm watches at most one session at any time.

So a subscription is not a set:

```ts
sessionId: string | null
```

Meaning:

- `string`: this Arm is currently watching this session;
- `null`: this Arm is not watching any session;
- A → B: atomically replace the current subscription A with B;
- A → null: leave the session page;
- subscribing to several sessions at once is not supported;
- no `sessionIds[]`, generation or subscription epoch is needed.

Core path:

```text
Arm --E2E unicast set_session_subscription(B)--> Tentacle

Tentacle:
  currentSessionByArm[armDeviceId] = B

Tentacle --E2E unicast session_subscription_set(B, snapshot)--> Arm

Afterwards:
  session B delta/card
    -> opaque multicast(to: every Arm currently watching B)
    -> Head
    -> each target Arm
```

In phase one, only these high-frequency messages are filtered by subscription:

```text
agent_message_delta
card_action
```

These messages keep going to all online Arms:

```text
session_list
user_message
agent_message
active
idle
compacting
session metadata
permission/question preview state
```

TRACE, attachments and the history spine remain on-demand unicast pulls.

---

# Part I: Outer relay protocol + Pulse 0.4 streams

## 2. Pulse 0.4 priority model

This proposal builds on Pulse `0.4.1`'s multi-stream transport and adds no business-level numeric priority field.

Kraki uses two fixed logical streams:

```ts
const STREAM_LIVE = 0;
const STREAM_BULK = 1;
```

| Stream | Semantics | Messages in this proposal |
|---|---|---|
| `0` live | High priority, interaction and current state | `session_list`, `set_session_subscription`, `session_subscription_set`, `agent_message_delta`, `card_action`, input/abort/permission/question control |
| `1` bulk | Background, large responses | `session_messages_*_batch`, `turn_trace_batch`, `attachment_data` |

Pulse 0.4 guarantees:

- each stream has its own `epoch/seq/ack/outbox/recvCursor`;
- within a stream, in-order and exactly-once, or an explicit reset;
- a hole in stream 0 does not block stream 1, and a hole in stream 1 does not block stream 0;
- `StreamSet.onTick()` returns transmit effects for lower stream IDs first, so live gets scheduling priority;
- there is no global ordering across streams;
- this is not hard preemption of bulk bytes already in the WebSocket/kernel buffer.

So the whole subscription assurance control chain must stay on stream 0. The history spine, TRACE and attachment reconciliation live on stream 1 and must not be treated as part of a stream-0 page-entry barrier.

The current release of Head, Tentacle and Web already uses Pulse 0.4 multi-stream; this protocol does not consider compatibility, and when iOS implements subscriptions it must use the same live/bulk `StreamSet`.

## 3. New `MulticastEnvelope`

Current protocol:

```ts
export type RelayEnvelope =
  | UnicastEnvelope
  | BroadcastEnvelope;
```

Changed to:

```ts
export interface MulticastEnvelope extends PulseFrameField {
  type: 'multicast';

  /** Explicit target device set visible to Head. */
  to: string[];

  /** Unused in Pulse mode; the ciphertext is in the pulse DATA payload. */
  blob: string;

  /** Unused in Pulse mode; recipient keys are in the pulse DATA payload. */
  keys: Record<string, string>;

  /** Optional error correlation ID. */
  ref?: string;
}

export type RelayEnvelope =
  | UnicastEnvelope
  | MulticastEnvelope
  | BroadcastEnvelope;
```

Outer JSON:

```json
{
  "type": "multicast",
  "to": ["app_phone", "app_web"],
  "pulse": "<base64 Pulse frame>",
  "blob": "",
  "keys": {}
}
```

The Pulse DATA payload keeps the existing E2E structure:

```json
{
  "blob": "<one AES ciphertext>",
  "keys": {
    "app_phone": "<phone wrapped AES key>",
    "app_web": "<web wrapped AES key>"
  }
}
```

Therefore:

- the plaintext is serialized only once;
- the content is AES-encrypted only once;
- each recipient adds only one wrapped key;
- Head forwards based only on the outer `to`;
- Head never sees the `sessionId`, message type or content.

## 4. Responsibilities of the three envelopes

| Envelope | Target | Use |
|---|---|---|
| `unicast` | One device ID | Arm commands, subscription request/ACK, ranges, TRACE, attachments |
| `multicast` | An explicit set of device IDs | Subscriber live data, global app control messages |
| `broadcast` | Same-user devices chosen dynamically by Head | No longer used for the new business data plane; can be removed later |

Even when a message goes to all online Arms, Tentacle should build an explicit app device target list and use multicast, not broadcast.

This naturally fixes the current pointless fanout of Tentacle data to other Tentacles.

## 5. Head multicast validation

When Head receives an authenticated multicast it must:

1. require `pulse` to be a string;
2. require `to` to be a non-empty array;
3. require every target to be a non-empty device ID;
4. deduplicate targets;
5. cap the number of targets, e.g. at most 64;
6. reject the sender itself;
7. reject `@head`;
8. require all targets to belong to the same user as the sender;
9. in phase one, allow only `tentacle -> app` multicast;
10. skip targets that are currently offline;
11. not create a non-durable backlog for offline targets;
12. not parse the Pulse DATA payload;
13. not compare the outer `to` with the inner E2E `keys`.

Recommended cap:

```text
MAX_MULTICAST_TARGETS = 64
```

If Tentacle has more than 64 targets, it should split them into stable groups, building the ciphertext and multicast separately for each group.

## 6. Multicast carries only non-durable live/control data

In phase one, multicast is used for:

```text
agent_message_delta
card_action
session_list
user_message / agent_message live notification
active / idle / compacting
session metadata
```

All of these have their own recovery authority, so multicast DATA must be:

```text
durable = false
```

Offline Arms do not accumulate a multicast live backlog; after reconnecting they recover through:

```text
session_list
subscription snapshot
spine range sync
TRACE pull
```

Head should get optional machine-readable error codes:

```ts
export type ServerErrorCode =
  | 'multicast_invalid_targets'
  | 'multicast_too_many_targets'
  | 'multicast_target_forbidden'
  | 'multicast_durable_not_supported'
  | 'push_dispatch_forbidden';

export interface ServerErrorMessage {
  type: 'server_error';
  message: string;
  code?: ServerErrorCode;
  ref?: string;
}
```

---

## 7. Pulse routing targets must be bound to `(streamId, DATA seq)`

Pulse 0.4's live and bulk streams have separate seq spaces; both streams can have `seq = 1` at the same time. Storing targets by seq alone would collide.

The current Tentacle Pulse 0.4 implementation already uses a per-stream target map to fix old unicast repairs losing their target. Multicast must extend the same abstraction:

```ts
export type DeliveryTarget =
  | { kind: 'unicast'; deviceId: string }
  | { kind: 'multicast'; deviceIds: string[] }
  | { kind: 'broadcast' };

private targetByStream = new Map<
  number,
  Map<bigint, DeliveryTarget>
>();
```

Sending:

```ts
const { seq, effects } = streams.send(streamId, payload, options);
let targets = targetByStream.get(streamId);
if (!targets) {
  targets = new Map();
  targetByStream.set(streamId, targets);
}
targets.set(seq, target);
run(effects);
```

On every transmit, including repair/resend:

```ts
const decoded = decodeFrameWithStream(effect.bytes);
const target = decoded?.frame.t === 'data'
  ? targetByStream.get(decoded.streamId)?.get(decoded.frame.seq)
  : undefined;
```

Cleanup after ACK:

```ts
const targets = targetByStream.get(effect.streamId ?? STREAM_LIVE);
for (const seq of targets?.keys() ?? []) {
  if (seq <= effect.seqUpTo) targets?.delete(seq);
}
```

This guarantees that repairs keep the correct target for both unicast and multicast on both streams.

### 7.1 Head keeps no second route registry

Having verified Pulse 0.4's hole/repair behavior, Head does not need to maintain a separate:

```text
(sourceDeviceId, streamId, seq) -> route
```

When a source stream receives DATA out of order, Pulse does not buffer the later payload at the application layer and deliver it together when the earlier frame arrives; it explicitly requests a repair. The resend of missing DATA is a new, independent `transmit` effect.

So the sender's job is: for every original send or repair/resend, regenerate the outer envelope with the correct target based on `(streamId, seq)`.

For the current envelope, Head only needs to:

1. decode `streamId`;
2. validate the current outer `to` or `to[]`;
3. feed the frame to the source `StreamSet`;
4. if the current frame produces a `deliver`, use the current envelope's targets;
5. forward the payload to the same `streamId` of each destination.

This matches the current Pulse 0.4 unicast target-retention pattern. Multicast only extends the target value kept by the sender from a single device ID to an array of device IDs.

Control frames have no business target; their envelopes take no part in DATA delivery.

---

## 8. Push is independent of live multicast

Today `pushPreview` is attached to the broadcast live envelope. If there are no online recipients, Tentacle returns before generating the preview, so there is no push when everyone is offline.

With subscriptions, push must be split out into an independent Head-bound operation.

Reusing the existing:

```ts
HEAD_PULSE_TARGET = '@head'
```

Add a Head-terminated control message:

```ts
export interface DispatchPushMessage {
  type: 'dispatch_push';
  payload: {
    preview: BlobPayload;
  };
}
```

Tentacle sends an outer unicast:

```json
{
  "type": "unicast",
  "to": "@head",
  "pulse": "<Pulse frame containing the dispatch_push JSON>",
  "blob": "",
  "keys": {}
}
```

Head's self channel sees:

```json
{
  "type": "dispatch_push",
  "payload": {
    "preview": {
      "blob": "<encrypted preview>",
      "keys": {
        "app_phone": "<wrapped key>",
        "app_web": "<wrapped key>"
      }
    }
  }
}
```

Head rules:

1. the sender must be authenticated;
2. the sender role must be `tentacle`;
3. push only to offline app devices of the same user;
4. each target must have a matching `preview.keys[deviceId]`;
5. Head does not decrypt the preview;
6. whether a session has subscribers does not affect push.

---

# Part II: Single session subscription protocol

## 9. New `set_session_subscription`

Arm-to-Tentacle E2E inner message:

```ts
export interface SetSessionSubscriptionMessage extends BaseEnvelope {
  type: 'set_session_subscription';
  payload: {
    /** The single session to watch; null means watch no session. */
    sessionId: string | null;
  };
}
```

Subscribing to session A:

```json
{
  "type": "set_session_subscription",
  "deviceId": "app_phone",
  "seq": 901,
  "timestamp": "2026-07-15T10:00:01.000Z",
  "payload": {
    "sessionId": "sess_A"
  }
}
```

Clearing the current subscription:

```json
{
  "type": "set_session_subscription",
  "deviceId": "app_phone",
  "seq": 902,
  "timestamp": "2026-07-15T10:01:00.000Z",
  "payload": {
    "sessionId": null
  }
}
```

It goes to Tentacle through the existing outer unicast:

```json
{
  "type": "unicast",
  "to": "dev_tentacle",
  "pulse": "<E2E set_session_subscription>",
  "blob": "",
  "keys": {}
}
```

So the inner message needs no `targetDeviceId`. The outer unicast's `to` is already the sole routing authority.

## 10. Why no generation is needed

A generation was meant to handle several replace-set requests arriving out of order.

The protocol already has:

```text
the same Arm -> Tentacle Pulse source stream
strict seq order
in-order deliver
```

And the product requires:

```text
an Arm has only one session page at a time
subscription transitions must be assured serially
at most one subscription request in flight at a time
```

So a second ordering number is unnecessary.

The correct constraints are:

```text
the Arm never sends several set_session_subscription concurrently
Pulse handles reliable delivery/retransmission of the current request
the Arm starts no concurrent application-level retries
on first connect/reconnect, wait for the post-auth session_list inbound barrier
subscription ACKs before the barrier never take part in page assurance
after the barrier, send exactly one request for the current desiredSessionId
```

If the user switches pages quickly before the ACK:

1. the Arm updates its local `desiredSessionId`;
2. the current request keeps waiting for its ACK;
3. when the ACK arrives, if the ACK's session is no longer the desired one, do not become ready;
4. immediately send the latest desired session;
5. intermediate page selections can be coalesced; only the final desired value is sent.

This is a serial state machine, not multi-generation replicated state.

## 11. Tentacle subscription state

Tentacle keeps only:

```ts
private currentSessionByArm = new Map<DeviceId, SessionId | null>();
```

On receiving a request:

```text
sessionId = string
  -> verify the session belongs to this Tentacle
  -> atomically replace the Arm's old subscription

sessionId = null
  -> delete/clear the Arm's subscription
```

An Arm switching from A to B:

```text
currentSessionByArm[arm] = A
receive set_session_subscription(B)
currentSessionByArm[arm] = B
```

No unsubscribe for A needs to be sent first.

When a device disconnects:

```text
device_left -> currentSessionByArm.delete(deviceId)
```

The map is empty after a Tentacle restart or a socket replacement with the same device ID. Even when the Arm's own WebSocket did not drop, Head provides a connection epoch signal: `device_left` for a normal disconnect, and a new `device_joined` for an atomic replacement without an offline window. On either signal the Arm must revoke its old confirmed/in-flight authority for that Tentacle and drop the old barrier; the new connection's `session_list` barrier then resends the current desired session.

---

## 12. New `session_subscription_set` ACK

### 12.1 Snapshot type

```ts
export interface SessionLiveSnapshot {
  /** runtime/sidebar authority */
  digest: SessionDigest;

  /** persistent spine recovery boundary */
  spineHeadSeq: number;

  /** current CardManager state */
  card: {
    draft: string;
    action: CardActionState | null;
  };
}
```

### 12.2 ACK type

```ts
export interface SessionSubscriptionSetMessage extends BaseEnvelope {
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

Subscribed successfully:

```json
{
  "type": "session_subscription_set",
  "deviceId": "dev_tentacle",
  "seq": 2204,
  "timestamp": "2026-07-15T10:00:01.020Z",
  "payload": {
    "accepted": true,
    "sessionId": "sess_A",
    "snapshot": {
      "digest": {
        "id": "sess_A",
        "agent": "pi",
        "state": "active",
        "mode": "execute",
        "lastSeq": 42,
        "readSeq": 38,
        "messageCount": 42,
        "createdAt": "2026-07-15T09:00:00.000Z"
      },
      "spineHeadSeq": 42,
      "card": {
        "draft": "I am checking the protocol…",
        "action": {
          "type": "tool_start",
          "payload": {
            "toolName": "read",
            "headline": "Read protocol files"
          }
        }
      }
    }
  }
}
```

Cleared successfully:

```json
{
  "type": "session_subscription_set",
  "deviceId": "dev_tentacle",
  "seq": 2205,
  "timestamp": "2026-07-15T10:01:00.020Z",
  "payload": {
    "accepted": true,
    "sessionId": null,
    "snapshot": null
  }
}
```

### 12.3 Failure ACK

An unknown session still uses the dedicated ACK rather than a generic `error`, so page subscription assurance waits for only one response type:

```json
{
  "type": "session_subscription_set",
  "deviceId": "dev_tentacle",
  "seq": 2206,
  "timestamp": "2026-07-15T10:02:00.020Z",
  "payload": {
    "accepted": false,
    "sessionId": "sess_missing",
    "error": {
      "code": "session_not_found",
      "message": "Session not found"
    }
  }
}
```

On failure:

- Tentacle does not change the Arm's current subscription;
- the Arm does not become liveReady;
- the page shows a load failure or returns to the list;
- since only one subscription request is in flight at a time, no extra request ID, generation or ref is needed.

---

# Part III: Page timing assurance

## 13. Switching from A to B within the same Tentacle

The page layer must keep:

```ts
interface SessionSubscriptionState {
  desiredSessionId: string | null;
  confirmedSessionId: string | null;
  requestInFlight: boolean;
}
```

Switching steps:

```text
1. The user navigates from A to B
2. desiredSessionId = B
3. confirmedSessionId = null; immediately stop applying A's subscriber-only live frames
4. Page B enters the subscriptionPending state
5. If no request is in flight: send set_session_subscription(B)
6. Tentacle atomically switches A -> B
7. Tentacle captures B's snapshot
8. Tentacle returns a unicast session_subscription_set(B, snapshot) with `accepted: true`
9. The Arm confirms desiredSessionId is still B
10. Apply the digest/card snapshot
11. confirmedSessionId = B
12. Page B becomes liveReady
13. Compare the local spine head with snapshot.spineHeadSeq
14. If there is a gap, start a range reconcile on bulk stream 1
15. spineReady once the range completes
```

Before step 11, page B:

- may show loading/skeleton;
- does not treat the old card state as B's current state;
- does not assume the live stream is established.

After step 12:

- subsequent stream-0 delta/card are applied immediately;
- the locally persisted spine cache may be shown;
- if `spineHeadSeq` shows a gap, a separate history reconcile/loading state is shown;
- live stream 0 is never held back waiting for bulk stream 1.

## 14. Quick A -> B -> C

If the B request has been sent but not yet ACKed and the user moves on to C:

```text
desiredSessionId = C
```

C is not sent concurrently.

When the B ACK arrives:

```text
ACK.sessionId = B
desiredSessionId = C
```

The Arm:

1. does not make B liveReady;
2. may discard the B snapshot;
3. immediately sends `set_session_subscription(C)`;
4. waits for the C ACK;
5. becomes liveReady after the C ACK.

Because requests are serial, repeating the same A/B/C values causes no generation ambiguity.

## 15. Leaving the session page

```text
desiredSessionId = null
send set_session_subscription(null)
```

The UI does not need to wait for the null ACK to leave the page, but the connection layer must still complete that request before sending the next subscription request.

If the user reopens B before the null ACK:

```text
desiredSessionId = B
```

Wait for the null ACK, then send B.

## 16. Switching across Tentacles

If A belongs to Tentacle X and B to Tentacle Y:

```text
1. Send set_session_subscription(null) to X
2. Immediately set confirmedSessionId = null
3. Wait for X's null ACK
4. Send set_session_subscription(B) to Y
5. Wait for Y's B snapshot ACK
6. confirmedSessionId = B
7. B liveReady
```

This always keeps the product invariant "an Arm has only one full live session at a time".

If the product ever allows split view, this protocol needs to be extended again; there is no array semantics reserved for a multi-session UI that does not exist.

## 17. Reconnect

After an Arm reconnects, `auth_ok` alone cannot be the starting point for subscription assurance. Head's destination Pulse endpoint may still hold brief non-durable frames left from the previous connection; if a new request were sent immediately, an old `session_subscription_set` could in theory arrive first.

So it must wait for the authoritative `session_list` sent by this Tentacle after authentication, as an inbound ordering barrier:

```text
1. Pulse/auth ready
2. Receive this Tentacle's post-auth session_list
   - in the Tentacle source stream it comes after this auth's initialization
   - in the Arm destination stream it comes after any earlier leftover frames
3. Discard any session_subscription_set received before the barrier
4. confirmedSessionId = null
5. If the current page is still B, desiredSessionId = B
6. send set_session_subscription(B) on stream 0
7. wait for the matching B snapshot ACK on stream 0
8. apply the digest/card snapshot
9. confirmedSessionId = B
10. liveReady
11. If there is a spine gap, start a range reconcile via a stream-0 request / stream-1 response
12. spineReady once the range completes
```

If there is no current session page:

```text
send set_session_subscription(null) after the session_list barrier
```

The page subscription state machine only accepts an ACK that arrives after the barrier, while a local request is actually in flight, and with `ACK.sessionId === desiredSessionId`. That way an unrelated ACK from the old connection cannot complete the new page's assurance, and no generation/request ID is needed.

Note that the two Pulse directions are independent: an old unacknowledged `set_session_subscription` in the Arm's live outbox may be resent automatically after reconnecting and produce a new ACK after the `session_list` barrier. That is still safe, because the command is an idempotent set-value, not a one-shot operation:

- ACK session differs from the current desired one: ignore it, do not end the current request;
- ACK session equals the current desired one: Tentacle has just re-applied the value and captured a snapshot, so it can be accepted;
- later duplicate ACKs are ignored when no request is in flight.

The `session_list` barrier only establishes an inbound boundary on Tentacle→Arm stream 0; it does not claim global ordering across both directions.

The `session_list` barrier, subscription request/ACK, card snapshot and subsequent delta/card are all on stream 0, so they stay strictly ordered. Old range/TRACE/attachment frames on stream 1 take no part in this barrier and cannot block liveReady.

This keeps Tentacle's subscription authority unambiguous at all times.

---

# Part IV: Snapshot ordering

## 18. Atomic order in which Tentacle handles a request

Tentacle must process in this order:

```text
1. validate sessionId
2. replace currentSessionByArm[armDeviceId]
3. capture SessionDigest
4. capture spineHeadSeq
5. capture CardManager draft/action
6. enqueue the unicast session_subscription_set ACK
7. only then process/send new adapter live events produced afterwards
```

The same Tentacle source **stream 0** is ordered, and Head maps the source stream unchanged onto the destination stream, so for the target Arm:

```text
subscription ACK
before
delta/card produced after the subscription was established
```

## 19. Old session frames

During an A -> B switch, old frames for A may already be in Head's -> Arm destination endpoint.

The Arm must only apply:

```ts
message.sessionId === confirmedSessionId
```

for subscriber-only types:

```text
agent_message_delta
card_action
```

If `message.sessionId !== confirmedSessionId`, drop it.

B subscriber-only frames that arrive before the B ACK are not applied either. With a correctly ordered implementation, B live frames come after the ACK; this rule is a defensive boundary.

## 20. Applying the snapshot

After the Arm receives a valid stream-0 ACK:

1. update the session runtime/metadata from `snapshot.digest`;
2. replace the local live card entirely with `snapshot.card`;
3. set `confirmedSessionId`;
4. the page becomes `liveReady` and subsequent stream-0 delta/card are allowed immediately;
5. compare the local persistent head with `snapshot.spineHeadSeq`;
6. if there is a gap, send a `request_session_messages_range` command on stream 0;
7. Tentacle returns `session_messages_range_batch` on stream 1;
8. keep `spineReady = false` while the range is incomplete, without revoking liveReady;
9. TRACE continues to be pulled independently on stream 1.

The card snapshot replaces; it is not merged with old card events.

---

# Part V: Message classification

## 21. Subscriber-only

Phase one:

```text
agent_message_delta
card_action
```

Tentacle computes the targets:

```ts
function subscribersFor(sessionId: string): string[] {
  return onlineAppDeviceIds.filter(
    deviceId => currentSessionByArm.get(deviceId) === sessionId,
  );
}
```

Then:

```text
targets = subscribersFor(sessionId)

if targets.length === 0:
  do not send the live frame
  do not enter pendingE2eQueue
else:
  encrypt once for targets
  multicast(targets)
```

## 22. Still multicast globally

In phase one these keep going to all online Arms:

```text
session_list
session_created
session_ended
session_deleted
user_message
agent_message
active
idle
compacting
session title/model/mode/pin/read
permission_resolved
question_resolved
```

So the sidebar, unread state and final-reply behavior do not need to be refactored at the same time.

## 23. Pull-only

These stay unicast request/response, but the request and response are on different streams:

| Operation | Arm request | Tentacle response |
|---|---:|---:|
| session messages/range | stream 0 | stream 1 |
| turn TRACE | stream 0 | stream 1 |
| attachment | stream 0 | stream 1 |

Specific messages:

```text
request_session_messages
request_session_messages_range
request_turn_trace
request_attachment
```

## 24. Transient state that is no longer replayed

These types do not enter the generic offline/pending queue:

```text
agent_message_delta
card_action
compacting
session_list
```

Recovery authorities:

| Data | Recovery authority |
|---|---|
| Draft | subscription snapshot `card.draft` |
| Card action | subscription snapshot `card.action` |
| Runtime | `SessionDigest.state` |
| Spine | `messages.jsonl` + range sync |
| TRACE | `trace.jsonl` + pull |

---

# Part VI: Reuse previews; no new Attention message

## 25. `SessionAttentionMessage` dropped

Do not add:

```text
SessionAttentionMessage
session_attention
```

Reason: the existing `SessionDigest.preview` can already express sidebar attention.

Current type:

```ts
export interface SessionPreviewDigest {
  text: string;
  type:
    | 'agent'
    | 'user'
    | 'error'
    | 'permission'
    | 'question'
    | 'answer';
  timestamp: string;
}
```

So question/permission need no second attention wire state.

## 26. What `updatePreview` is

The existing `updatePreview` in Web/iOS is a local client store helper, not a protocol message Tentacle can send.

The actual wire authority today is:

```text
session_list.payload.sessions[].preview
```

So the reuse path is:

```text
Tentacle updates SessionDigest.preview
-> sends the existing session_list
-> Web/iOS call the existing preview store/update logic on receipt
```

Not a new `update_preview` message.

## 27. When a permission/question opens

Tentacle keeps a low-frequency pending-preview authority:

```ts
interface PendingPreviewState {
  kind: 'permission' | 'question';
  text: string;
  openedAt: string;
}

private pendingPreviewBySession = new Map<string, PendingPreviewState>();
```

It is internal Tentacle state, not a new wire type.

`openedAt` must be generated when the prompt first opens and stay stable. Using the current time each time `session_list` is built would make a long-pending prompt keep jumping to the top of the sidebar on every session-list refresh.

Tentacle derives the digest preview from the current pending prompt.

### Permission

```ts
{
  type: 'permission',
  text: pending.text,
  timestamp: pending.openedAt,
}
```

where `pending.text` comes from:

```ts
action.payload.description || action.payload.toolName
```

### Question

```ts
{
  type: 'question',
  text: pending.text,
  timestamp: pending.openedAt,
}
```

where `pending.text` comes from `action.payload.question`.

Then the existing message is sent to all online Arms:

```text
session_list
```

So Arms not subscribed to that session still:

- see the permission/question preview in the sidebar;
- show the pending state;
- sort it by latest activity;
- enter session subscription assurance when tapped;
- get the full card from the snapshot.

## 28. When a permission/question is resolved

When a permission/question is:

```text
approved
denied
answered
auto-resolved
cancelled
idle-cleared
```

Tentacle recomputes the session preview:

- if a pending human action remains, keep its stable `openedAt` and pending preview;
- if the current pending action is resolved, delete `pendingPreviewBySession[sessionId]`;
- then fall back to the preview computed from the persistent spine;
- update SessionDigest.state;
- then send the existing `session_list`.

That way the sidebar pending badge is cleared authoritatively.

## 29. Why phase one accepts a full `session_list`

Permissions/questions are low-frequency control events, not a token firehose.

Benefits of reusing `session_list` in phase one:

- no new wire type;
- Web/iOS already handle it completely;
- preview, state, lastSeq and readSeq stay consistent together;
- reconnect authority is not split;
- a smaller protocol surface.

If the number of sessions ever grows large and the full `session_list` becomes a clear cost, add a generic:

```text
session_digest_updated
```

But it is not added in advance in this proposal.

## 30. Push must still be independent

Online sidebar attention can reuse `session_list.preview`.

Offline devices do not receive session_list, so they still need:

```text
dispatch_push -> @head
```

The two have different responsibilities:

| Path | Target |
|---|---|
| `session_list.preview` | Sidebar/pending state of online Arms |
| `dispatch_push` | System notifications for offline Arms |
| subscription snapshot | The full card/draft/runtime after opening a page |

---

# Part VII: Delta coalescing

## 31. Incremental deltas cannot simply keep-last

Today `agent_message_delta` is usually an incremental chunk:

```json
{
  "content": "next part",
  "reset": false
}
```

If the transport overwrote older chunks with newer ones, text would be lost.

Under multicast/coalescing, payloads to be coalesced must be state-covering.

One of two options:

### A. Merge incremental chunks not yet flushed

```text
"This" + " is a" + " test"
=> "This is a test"
```

### B. Coalescible frames carry the full draft

```json
{
  "content": "the current full draft",
  "reset": true
}
```

Either way, the subscription snapshot always carries the full draft as the recovery authority.

---

# Part VIII: Full TypeScript protocol diff

## 32. Outer relay additions

```ts
export interface MulticastEnvelope extends PulseFrameField {
  type: 'multicast';
  to: string[];
  blob: string;
  keys: Record<string, string>;
  ref?: string;
}

export type RelayEnvelope =
  | UnicastEnvelope
  | MulticastEnvelope
  | BroadcastEnvelope;

export type ServerErrorCode =
  | 'multicast_invalid_targets'
  | 'multicast_too_many_targets'
  | 'multicast_target_forbidden'
  | 'multicast_durable_not_supported'
  | 'push_dispatch_forbidden';

export interface ServerErrorMessage {
  type: 'server_error';
  message: string;
  code?: ServerErrorCode;
  ref?: string;
}

export interface DispatchPushMessage {
  type: 'dispatch_push';
  payload: {
    preview: BlobPayload;
  };
}
```

## 33. Inner subscription additions

```ts
export interface SetSessionSubscriptionMessage extends BaseEnvelope {
  type: 'set_session_subscription';
  payload: {
    sessionId: string | null;
  };
}

export interface SessionLiveSnapshot {
  digest: SessionDigest;
  spineHeadSeq: number;
  card: {
    draft: string;
    action: CardActionState | null;
  };
}

export interface SessionSubscriptionSetMessage extends BaseEnvelope {
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

Unions:

```ts
export type ConsumerMessage =
  | SetSessionSubscriptionMessage
  | /* existing */;

export type ProducerMessage =
  | SessionSubscriptionSetMessage
  | /* existing */;
```

Not added:

```text
RelayCapabilities
ApplicationProtocolCapabilities
SetSessionSubscriptionsMessage
SessionSubscriptionsSetMessage
subscriptionEpoch
generation
targetDeviceId
sessionIds[]
SessionAttentionMessage
session_digest_updated
```

---

# Part IX: Implementation invariants

## 34. Arm invariants

```text
at most one desired session
at most one confirmed session
at most one subscription request in flight
after reconnecting, first wait for the post-auth session_list inbound barrier
accept only subscription ACKs after the barrier, with a request in flight and a sessionId matching desired
automatic resends of an old outbound set-value are idempotent; no generation needed
only delta/card of the confirmed session may be applied
a page becomes liveReady only after a matching snapshot ACK
```

## 35. Tentacle invariants

```text
at most one current session per Arm
a new session atomically replaces the old one
the ACK snapshot comes before subsequent live events
subscriber-only events are not queued for offline/non-subscribed Arms
```

## 36. Head invariants

```text
does not understand sessions
does not understand subscriptions
only validates the user/device/role target set
each source DATA frame uses the target/target set on the current envelope, restored by the sender from `(streamId, seq)`
the source stream maps unchanged onto the destination stream
never decrypts payloads/push previews
```

---

## 37. Recommended protocol to accept

Accept the following final protocol shape:

1. `MulticastEnvelope { to: string[] }`;
2. Head stays session-blind and only routes device target sets;
3. `set_session_subscription { sessionId: string | null }`;
4. the inner request carries no `targetDeviceId`;
5. no capabilities, compatibility, epoch or generation;
6. each Arm has at most one subscribed session at a time;
7. a page becomes liveReady through the post-auth `session_list` barrier + serial request/ACK/snapshot assurance;
8. `session_subscription_set` returns a single session snapshot;
9. in phase one, subscriber-only means delta/card only;
10. no new `SessionAttentionMessage`;
11. online attention reuses the existing `session_list[].preview`;
12. both permissions and questions generate a preview with a stable `openedAt`, and refresh `session_list` when opened/resolved;
13. offline notifications keep using the separate `dispatch_push`;
14. the sender stores target/target set by `(streamId, DATA seq)`; Head needs no second route registry;
15. Head maps the source stream unchanged onto each destination stream.

Final data flow:

```text
global low-frequency session_list/preview/runtime
+ a single current-session live subscription
+ Head session-blind opaque multicast
+ snapshot ACK assurance on page entry
+ independent spine/TRACE/attachment recovery
+ independently sent offline push
```
