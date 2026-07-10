# Kraki Architecture

Kraki is a small distributed system for seeing and controlling AI coding sessions from another device. It separates the problem into three main responsibilities:

- `tentacle` runs beside the agent on the machine doing the work
- `head` is a thin encrypted relay that forwards messages
- `arm` gives you a UI on a phone or browser

The relay is deliberately minimal: it authenticates devices, forwards encrypted payloads over a reliable transport, and tracks device presence. Everything else — session management, message buffering, sequencing — lives at the edges.

## System at a glance

```text
Agent <-> tentacle == pulse/WSS ==> head (relay) == pulse/WSS ==> arm
```

`tentacle` and `arm` handle encryption and decryption. `head` forwards opaque encrypted payloads without being able to read their contents. The relay sees pulse frame headers (seq/ack/durable flags) and destination device IDs, nothing more.

## Pulse reliable transport

All application and control messages ride [`@coinfra/pulse`](https://github.com/corelli18512/coinfra/tree/main/packages/pulse) — a resumable, reliable byte-channel that replaces raw WebSocket fire-and-forget. Only the auth handshake, keepalive pings, and the pulse-envelope carrier remain on bare WebSocket.

**Per-hop model**: arm ⇄ head ⇄ tentacle each run a pulse `Endpoint`. The head is a multi-connection hub with SQLite-backed durable store-and-forward. Every device gets its own endpoint on the head.

- **Reliable delivery**: pulse handles seq/ack, resend on loss, gap detection, and epoch-based resume across reconnects. Messages are delivered in-order, exactly-once to the application layer.
- **Durable messages**: a message can be marked `durable: true` — the head persists it to SQLite so it survives both the receiver being offline AND a head restart. Currently only `delete_session` is durable; all streaming/event messages are non-durable and self-heal via session replay on reconnect.
- **Send-time coalescing** (`coalesceKey`, pulse §12): state-covering streams like `agent_message_delta` and `card_action` declare a coalesce key. A new send with the same key drops earlier unacked entries from the outbox — a peer that was offline receives one current snapshot per key on reconnect instead of a burst of stale frames.
- **Host-driven GC** (pulse §11): the head runs a periodic GC scan. L1: after 5 min disconnected, a device's non-durable outbox is purged. L2: after 24 h disconnected, the in-memory endpoint is evicted entirely (durable state survives in SQLite for the next reconnect).

## Core concepts

### Device

Every participant is a device. Some devices produce agent events, some consume them, and some can do both.

### User

A user owns one or more devices. Routing is by `user_id` — the relay knows which devices belong to which user.

### Envelope

Messages travel in one of two envelope types:

- **Unicast** — sent from an app to a specific tentacle. Has a `to` field identifying the target device.
- **Broadcast** — sent from a tentacle to all of a user's connected devices.

Both envelope types carry a `pulse` field (base64-encoded pulse frame) whose payload segment is the opaque E2E ciphertext `{blob, keys}` JSON. The relay forwards the pulse frame without inspecting the payload.

### Session

A session represents one agent conversation or run. Sessions are identified by `sessionId` and owned by the device running the agent. Session state is managed entirely by tentacle and arm from the decrypted message stream — the relay knows nothing about sessions.

## Main components

### Head (relay)

`head` is a thin encrypted forwarder. It has exactly three jobs:

1. **Authenticate** — verify device identity on connect
2. **Forward pulse frames** — route unicast and broadcast envelopes to the right WebSocket connections via the per-device pulse hub
3. **Track identity** — maintain a users table, a devices table, and push token registration

`head` stores its state in SQLite (`users`, `devices`, `push_tokens`, `pulse_meta` for durable snapshots, `pulse_outbox` for durable outbox rows). It has zero visibility into message content.

When a device connects or disconnects, the relay sends `device_joined` / `device_left` control messages so other devices can update their presence view. The relay pings all connected devices every 30 seconds as a heartbeat.

### Tentacle

`tentacle` lives on the machine where the agent runs.

Its job is to:

- translate agent-specific events into Kraki protocol messages
- receive user actions from the relay and pass them back to the agent
- manage local device identity and connection state
- encrypt all outgoing messages and decrypt incoming ones
- assign per-session sequence numbers and timestamps
- handle session replay via `request_session_messages_range` (file-backed, not relayed)
- manage session lifecycle (create, update, close)
- auto-approve tools from a local allowed list
- store image attachments and serve them on demand
- expose a local MCP server (`kraki-show_image`)

The repository includes adapters for **GitHub Copilot**, **Claude Code**, and **pi**. The adapter boundary is intentionally separated so more agents can be added.

### Arm

`arm` is the receiving client — primarily the web app / PWA.

Its job is to:

- decrypt incoming payloads and build session state from the message stream
- show session history and current state
- surface permissions, questions, and errors
- send user actions back to the correct session
- maintain UI state: read tracking, unread counts, active session
- register push notification tokens and display notifications via service worker

## Message flows

### 1. Device connect and authentication

1. A device opens a WebSocket connection to `head`.
2. It sends an auth message (`github_token`, `github_oauth`, `pairing`, `challenge`, `apikey`, or `open`).
3. `head` validates identity, registers the device, and confirms the connection.
4. `head` sends `device_joined` to the user's other connected devices.

### 2. Session activity (tentacle → arm)

1. The agent produces an event.
2. `tentacle` converts it into a protocol message, encrypts it to online consumers, and sends via pulse broadcast.
3. `head`'s pulse hub fans the frame out to each online arm's endpoint, which delivers it reliably.
4. `arm` decrypts and updates the UI.

### 3. User actions (arm → tentacle)

1. The user approves a permission, answers a question, or sends input from `arm`.
2. `arm` encrypts the action and sends via pulse unicast addressed to the target tentacle.
3. `head`'s pulse hub forwards the frame to that tentacle's endpoint.
4. `tentacle` decrypts and hands the action to the agent runtime.

### 4. Replay after reconnect

1. A device reconnects to `head`.
2. Pulse resumes the stream (epoch handshake + resend from outbox).
3. For messages the arm missed while offline, `arm` sends `request_session_messages_range` — `tentacle` reads from its file-backed message log and replies with `session_messages_range_batch`.
4. The client rebuilds session state from the replayed message stream.

### 5. Push notifications (offline devices)

1. An agent event occurs (permission, question, or turn completion) while a device is offline.
2. `tentacle` creates a small encrypted preview (`pushPreview`) encrypted to ALL consumer keys (online + offline), attached to the same pulse broadcast envelope.
3. `head` detects `pushPreview` on the broadcast, queries `push_tokens` for offline devices.
4. For each offline device with a registered token and a matching key in the preview, `head` sends the preview via the push service (APNs, FCM, or Web Push/VAPID).
5. The device's service worker receives the push, decrypts the preview, and shows a notification with the actual content.

### 6. Image attachments

Image bytes travel as a separate chunked stream, not inline in activity messages.

1. The agent invokes the `kraki-show_image` MCP tool.
2. `tentacle` stores bytes content-addressed under `~/.kraki/sessions/<sid>/attachments/`.
3. The `tool_complete` message carries an `AttachmentRef` (id, size, mime, caption) — never bytes.
4. `tentacle` pushes bytes as `attachment_data` chunks (≤ 2 MB each) over the broadcast channel.
5. Receivers decrypt, reassemble, write to IndexedDB (LRU-bounded cache).
6. Late joiners send `request_attachment`; `tentacle` serves chunks on demand.

## Trust boundaries

| Component | What it sees |
|-----------|-------------|
| Tentacle / agent machine | Everything — plaintext before encryption |
| Head / relay | Pulse frame header (seq/ack/durable), envelope type, `to` device ID, sender device ID, payload size |
| Arm / receiver device | Everything — plaintext after decryption |

This is the central architectural choice in Kraki: the relay is a dumb pipe for encrypted payloads, while the endpoints keep full control of content.

## Repository layout

- `packages/protocol` — shared envelope, message, and auth type definitions
- `packages/crypto` — encryption primitives and blob helpers
- `packages/head` — thin relay server (pulse hub + push + auth)
- `packages/tentacle` — CLI bridge, agent adapters, session management
- `packages/arm/web` — web receiver / PWA
- `packages/tests` — integration coverage

For the threat model, see [`security.md`](./security.md). For the 2026-07-10 pulse outage post-mortem and debugging tools, see [`pulse-outage-postmortem.md`](./pulse-outage-postmortem.md).
