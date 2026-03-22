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

This package contains the shared message, device, channel, session, and tool-call types used across the relay, tentacle, and receiver apps.

## Install

```bash
npm i @kraki/protocol
```

## What it includes

- message envelopes and payload types
- channel, device, and session models
- tool-call and tool-result shapes
- shared contracts used by `@kraki/head`, `@kraki/tentacle`, and `@kraki/arm-web`

## Example

```ts
import type {
  ClientToServerMessage,
  DeviceInfo,
  SessionInfo,
} from '@kraki/protocol';
```

This package is the schema layer only. It does not include a runtime client or server.

## Links

- Main docs: `https://github.com/corelli18512/kraki/blob/main/README.md`
- Architecture: `https://github.com/corelli18512/kraki/blob/main/ARCHITECTURE.md`
