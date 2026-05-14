# Kraki Architecture

Kraki is a small distributed system for seeing and controlling AI coding sessions from another device. It separates the problem into three main responsibilities:

- `tentacle` runs beside the agent on the machine doing the work
- `head` is a thin encrypted relay that forwards messages
- `arm` gives you a UI on a phone or browser

The relay is deliberately minimal: it authenticates devices, forwards encrypted blobs, and tracks device presence. Everything else — session management, message buffering, sequencing — lives at the edges.

## System at a glance

```text
Agent <-> tentacle == WSS ==> head (relay) == WSS ==> arm
```

`tentacle` and `arm` handle encryption and decryption. `head` forwards opaque blobs without being able to read their contents. The relay sees envelope types and destination device IDs, nothing more.

## Core concepts

### Device

Every participant is a device. Some devices produce agent events, some consume them, and some can do both.

Examples:

- a laptop running an agent (tentacle)
- a browser tab showing session history (arm)
- a phone used to approve or answer prompts (arm)

### User

A user owns one or more devices. Routing is by `user_id` — the relay knows which devices belong to which user.

### Envelope

Messages travel in one of two envelope types:

- **UnicastEnvelope** — sent from an app to a specific tentacle. Has a `to` field identifying the target device.
- **BroadcastEnvelope** — sent from a tentacle to all of a user's connected devices. Has an optional `notify` hint.

Both envelopes carry a `blob` field: `base64(iv ‖ ciphertext ‖ tag)`. The relay forwards the blob without inspecting it.

### Session

A session represents one agent conversation or run. Sessions are identified by `sessionId` and owned by the device running the agent. Session state is managed entirely by tentacle and arm from the decrypted message stream — the relay knows nothing about sessions.

### Sequence numbers

Sequence numbers and timestamps are assigned by `tentacle`, not by the relay. This keeps ordering consistent even though the relay is stateless with respect to message content.

## Main components

### Head (relay)

`head` is a thin encrypted forwarder. It has exactly three jobs:

1. **Authenticate** — verify device identity on connect
2. **Forward blobs** — route unicast and broadcast envelopes to the right WebSocket connections
3. **Track identity** — maintain a users table and a devices table

That is the complete scope. `head` stores two database tables (`users` and `devices`) and has zero visibility into message content.

When a device connects or disconnects, the relay sends `device_joined` / `device_left` control messages so other devices can update their presence view. The relay pings all connected devices every 30 seconds as a heartbeat.

### Tentacle

`tentacle` lives on the machine where the agent runs.

Its job is to:

- translate agent-specific events into Kraki protocol messages
- receive user actions from the relay and pass them back to the agent
- manage local device identity and connection state
- encrypt all outgoing messages and decrypt incoming ones
- assign sequence numbers and timestamps to messages
- buffer messages for replay on reconnect
- manage session lifecycle (create, update, close)
- auto-approve tools from a local allowed list
- store image attachments produced by the agent and serve them on demand to authenticated receivers
- expose a local MCP server (`kraki-show_image` and friends) so agents can present images to the user explicitly

Today the repository includes a Copilot-focused adapter. The adapter boundary is intentionally separated so more agents can be added without changing the relay or UI model.

### Arm

`arm` is the receiving client. Today that primarily means the web app / PWA.

Its job is to:

- decrypt incoming blobs and build session state from the message stream
- show session history and current state
- surface permissions, questions, and errors
- send user actions back to the correct session
- maintain UI state: read tracking, unread counts, active session, session deletion
- send periodic pings for WebSocket proxy keepalive
- register push notification tokens and display notifications via service worker

## Message flows

### 1. Device connect and authentication

1. A device opens a WebSocket connection to `head`.
2. It sends an auth message using one of the supported methods (a discriminated union): `github_token`, `github_oauth`, `pairing`, `challenge`, `apikey`, or `open`.
3. `head` validates identity, registers the device, and confirms the connection.
4. `head` sends `device_joined` to the user's other connected devices.

### 2. Session activity (tentacle → arm)

1. The agent produces an event.
2. `tentacle` converts it into a protocol message, encrypts it into a blob, and sends a **BroadcastEnvelope**.
3. `head` forwards the envelope to all of the user's other connected devices.
4. `arm` decrypts the blob and updates the UI.

### 3. User actions (arm → tentacle)

1. The user approves a permission request, answers a question, or sends follow-up input from `arm`.
2. `arm` encrypts the action into a blob and sends a **UnicastEnvelope** with the target tentacle's device ID in the `to` field.
3. `head` forwards the envelope to that specific device.
4. `tentacle` decrypts and hands the action back to the agent runtime.

### 4. Replay after reconnect

1. A device reconnects to `head`.
2. `tentacle` (not the relay) handles replay: it re-sends buffered messages to the reconnected device on request.
3. The client rebuilds session state from the replayed message stream.

### 5. Device discovery

1. When a device connects, `head` sends `device_joined` to the user's other devices.
2. When a device disconnects, `head` sends `device_left`.
3. Devices use these signals to maintain an up-to-date presence view.

### 6. Push notifications (offline devices)

1. An agent event occurs (permission, question, or turn completion) while a device is offline.
2. `tentacle` creates a small encrypted preview (`pushPreview`) alongside the full broadcast blob.
3. `head` detects `pushPreview` on the broadcast, queries `push_tokens` for offline devices.
4. For each offline device with a registered token, `head` sends the preview blob via the appropriate push service (APNs, FCM, or Web Push/VAPID).
5. The device's service worker (or Notification Service Extension on iOS) receives the push, decrypts the preview using the device's private key, and shows a notification with the actual content.
6. The relay never sees the notification content — it forwards the same opaque encrypted blob through the push service as it does through WebSocket.

### 7. Image attachments

Image bytes do not travel inline inside agent activity messages. Instead they flow as a separate, chunked stream so that broadcast and replay payloads stay small.

1. The agent invokes the `kraki-show_image` MCP tool with a path and an optional caption (see "Kraki MCP server" below). Images surfaced by any other tool (e.g. `view`) are deliberately dropped — only `kraki-show_image` is treated as an intent to present.
2. `tentacle` stores the bytes in a content-addressed attachment store under the session directory (`~/.kraki/sessions/<sid>/attachments/<id>.<ext>` with a `<id>.json` sidecar). The id is a truncated sha256 of the bytes.
3. The accompanying `tool_complete` message carries an `AttachmentRef` (id, size, mime, optional dimensions, name, caption) — never bytes. `messages.jsonl` stays small forever.
4. After the message is broadcast, `tentacle` pushes the bytes as a sequence of `attachment_data` chunks (≤ 2 MB plaintext each) over the existing broadcast channel, encrypted per-recipient like any other message. The relay's 10 MB `maxPayload` is never approached.
5. Receivers decrypt and reassemble chunks, write the blob to IndexedDB keyed by id, and render the image. The IDB cache is bounded (LRU eviction at ~50–200 MB depending on storage quota).
6. If a receiver joins late (replay) or has evicted the bytes, it sends a `request_attachment` unicast. `tentacle` looks up the id on disk and serves it as `attachment_data` chunks back to that specific device. Bytes only leave the tentacle in response to an authenticated session-member request.

Future MCP tools that present non-image artifacts will reuse the same ref + chunk transport — the only thing that changes is the discriminator on `Attachment`.

## Kraki MCP server

A loopback HTTP server runs in-process inside the daemon. It is wired into Copilot's `mcpServers` configuration with a per-session URL and a per-session bearer token; only the local agent process can reach it. It is *not* exposed to the relay.

For v1 the server registers one tool:

- **`kraki-show_image(path, caption?)`** — read a file from disk, register its bytes with the attachment store, and return a refusal of the LLM-feed bytes so the agent does not see the image itself. The bytes flow to user-facing receivers via the attachment pipeline described above.

Tool names follow Copilot's `<server>-<tool>` display convention (dash, not dot). The adapter correlates `tool.execution_start` and `tool.execution_complete` events via `toolCallId` because Copilot's SDK strips `mcpServerName`/`mcpToolName` from the complete event.

If the MCP server fails to start (port collision, etc.) the daemon stays up, logs a warning, and omits the `kraki-show_image` tool from the agent's available tools — the rest of the session works as normal.

## Trust boundaries

| Component | What it sees |
|-----------|-------------|
| Tentacle / agent machine | Everything — plaintext before encryption |
| Head / relay | Envelope type (unicast/broadcast), `to` device ID, sender device ID, blob size |
| Arm / receiver device | Everything — plaintext after decryption |

This is the central architectural choice in Kraki: the relay is a dumb pipe for encrypted blobs, while the endpoints keep full control of content.

## Repository layout

- `packages/protocol` — shared envelope, message, and auth type definitions
- `packages/crypto` — encryption primitives and blob helpers
- `packages/head` — thin relay server
- `packages/tentacle` — CLI bridge, agent adapters, message buffering
- `packages/arm/web` — web receiver / PWA
- `packages/tests` — integration coverage

If you want the threat model rather than the runtime design, read [`SECURITY.md`](./SECURITY.md).
