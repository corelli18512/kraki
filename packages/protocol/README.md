<p align="center">
  <a href="https://github.com/corelli18512/kraki">
    <img src="https://raw.githubusercontent.com/corelli18512/kraki/main/logo.png" alt="Kraki" width="140">
  </a>
</p>

<p align="center">
  <a href="https://github.com/corelli18512/kraki">GitHub repository</a>
</p>

# @kraki/protocol

Shared TypeScript types and protocol contracts for Kraki.

> Preview: `@kraki/protocol` may still evolve as Kraki's message model and clients expand.

This package contains the shared envelope, message, device, and auth types used across the relay, tentacle, and receiver apps.

## Install

```bash
npm i @kraki/protocol
```

## What it includes

### Envelope types

- **UnicastEnvelope** — sent from an app to a specific tentacle. Contains a `to` field identifying the target device and a `blob` with the encrypted payload.
- **BroadcastEnvelope** — sent from a tentacle to all of a user's connected devices. Contains a `blob` and an optional `notify` hint.

### Inner message types (inside encrypted blob)

- **ProducerMessage** — messages from tentacle: session events, agent output, tool calls, permission requests.
- **ConsumerMessage** — messages from arm: approvals, answers, follow-up input.

These types are only visible after decryption. The relay never sees them.

### Control messages (unencrypted, relay-level)

- **auth** — device authentication (discriminated union: `github_token`, `github_oauth`, `pairing`, `challenge`, `apikey`, `open`)
- **device_joined** / **device_left** — presence notifications from the relay
- **ping** / **pong** — heartbeat

### Device and user models

- device registration, identity, and public key types
- user identity types

## Example

```ts
import type {
  UnicastEnvelope,
  BroadcastEnvelope,
  DeviceInfo,
  AuthMethod,
} from '@kraki/protocol';
```

This package is the schema layer only. It does not include a runtime client or server.

## Links

- Main docs: `https://github.com/corelli18512/kraki/blob/main/README.md`
- Architecture: `https://github.com/corelli18512/kraki/blob/main/ARCHITECTURE.md`
