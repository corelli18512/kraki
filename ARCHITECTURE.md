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
