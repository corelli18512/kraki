# Kraki Architecture

Kraki is a small distributed system for seeing and controlling AI coding sessions from another device. It separates the problem into three main responsibilities:

- `tentacle` runs beside the agent on the machine doing the work
- `head` authenticates devices, routes messages, and stores replay history
- `arm` gives you a UI on a phone or browser

That split keeps the relay simple, keeps the UI independent from the agent runtime, and makes it possible to add new agent adapters or clients later.

## System at a glance

```text
Agent <-> tentacle == WSS ==> head == WSS ==> arm
```

In trusted mode, `head` can store plaintext session data because you run the relay yourself.

In end-to-end encrypted mode, `tentacle` and `arm` handle encryption and decryption. `head` routes and stores ciphertext plus the metadata needed to deliver it.

## Core concepts

### Channel

A channel is a user's shared message space. The devices that belong together connect to the same channel so they can exchange session updates and control messages.

### Device

Every participant is a device. Some devices produce agent events, some consume them, and some can do both.

Examples:

- a laptop running an agent
- a browser tab showing session history
- a phone used to approve or answer prompts

### Session

A session represents one agent conversation or run. Sessions are identified by `sessionId` and owned by the device running the agent.

### Sequence numbers

Every message on a channel gets a monotonically increasing `seq` number. This gives Kraki three important properties:

- ordered delivery
- replay after reconnect
- deduplication when connections are interrupted

## Main components

### Tentacle

`tentacle` lives on the machine where the agent runs.

Its job is to:

- translate agent-specific events into Kraki protocol messages
- receive user actions from the relay and pass them back to the agent
- manage local device identity and connection state
- perform encryption when end-to-end mode is enabled

Today the repository includes a Copilot-focused adapter. The adapter boundary is intentionally separated so more agents can be added without changing the relay or UI model.

### Head

`head` is the relay server.

Its job is to:

- terminate WebSocket connections
- authenticate devices
- keep track of channels, devices, and session ownership
- route messages from producer devices to receiver devices
- persist replayable history
- restore state after reconnects or restarts

`head` should understand routing and trust boundaries, not every internal detail of a specific agent.

### Arm

`arm` is the receiving client. Today that primarily means the web app / PWA.

Its job is to:

- show session history and current state
- surface permissions, questions, and errors
- send user actions back to the correct session
- maintain UI state such as unread counts and active session context
- decrypt content locally in end-to-end mode

## Typical message flow

### 1. Device connect and authentication

1. A device opens a WebSocket connection to `head`.
2. It authenticates using the deployment's chosen method, such as pairing, GitHub identity, API key, or open mode.
3. `head` returns the current device and session snapshot so the client can recover quickly.

### 2. Session activity

1. The agent produces an event.
2. `tentacle` converts it into a Kraki message.
3. `head` assigns order, stores what should be replayable, and fans the message out to receiving devices.
4. `arm` updates the UI.

### 3. User actions back to the agent

1. The user approves a permission request, answers a question, or sends follow-up input from `arm`.
2. `head` routes that action to the tentacle that owns the session.
3. `tentacle` hands it back to the agent runtime.

### 4. Replay after reconnect

1. A device reconnects and tells `head` the last sequence number it saw.
2. `head` sends everything after that point.
3. The client rebuilds session state without re-running the underlying agent work.

## Trust boundaries

| Component | Sees plaintext in trusted mode | Sees plaintext in end-to-end mode |
|-----------|-------------------------------|-----------------------------------|
| Tentacle / agent machine | Yes | Yes |
| Head / relay | Yes | No, only routing metadata and encrypted blobs |
| Arm / receiver device | Yes | Yes, after local decryption |

This is the central architectural choice in Kraki: the relay handles delivery and history, while the endpoints keep control of content.

## Storage and replay

`head` stores enough data to make reconnects and session browsing practical:

- device registry and channel membership
- replayable message history
- session ownership and summary state
- pairing and auth-related records

Not every message needs to be persisted. Streaming deltas and transient control signals can stay real-time, while stable session events are stored for replay.

## Deployment shapes

### Trusted self-hosted

Use this when you control the server and want the simplest operational model. The relay can read stored content because it is your relay.

### End-to-end encrypted

Use this when you want the relay to forward traffic without being able to read message bodies. Endpoints encrypt and decrypt locally, and the relay stores ciphertext plus the metadata needed for routing.

## Repository layout

- `packages/protocol` - shared message definitions
- `packages/crypto` - cryptographic helpers
- `packages/head` - relay server
- `packages/tentacle` - CLI bridge and adapters
- `packages/arm/web` - web receiver
- `packages/tests` - integration coverage

If you want the threat model rather than the runtime design, read [`SECURITY.md`](./SECURITY.md).
