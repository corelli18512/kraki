<p align="center">
  <a href="https://github.com/corelli18512/kraki">
    <img src="https://raw.githubusercontent.com/corelli18512/kraki/main/logo.png" alt="Kraki" width="140">
  </a>
</p>

<p align="center">
  <a href="https://github.com/corelli18512/kraki">GitHub repository</a>
</p>

# @kraki/head

Thin encrypted relay that forwards messages between tentacles and apps.

> Preview: `@kraki/head` is still early-stage. Expect breaking changes while the hosted and self-hosted flows stabilize.

Use `@kraki/head` when you want to self-host the Kraki relay instead of using the hosted default.

## Install

Run it once with `npx`:

```bash
npx @kraki/head
```

Or install it globally:

```bash
npm i -g @kraki/head
kraki-relay
```

## Quick start

Start a local relay:

```bash
npx @kraki/head
```

By default the relay listens on `ws://localhost:4000` and stores user/device data in `kraki-head.db`.

Enable GitHub login for the web app:

```bash
GITHUB_CLIENT_ID=your_client_id \
GITHUB_CLIENT_SECRET=your_client_secret \
npx @kraki/head --auth github
```

## What the relay does

The relay has three jobs:

1. **Authenticate** — verify device identity on connect
2. **Forward blobs** — route unicast and broadcast envelopes to the right WebSocket connections
3. **Track identity** — maintain users and devices tables

It stores no messages, no sessions, and no content. All message bodies are encrypted blobs that the relay cannot read.

## Useful options

```bash
kraki-relay --port 8080
kraki-relay --db /path/to/kraki-head.db
kraki-relay --auth open
kraki-relay --auth github
kraki-relay --log debug
```

## Auth methods

The relay supports multiple authentication methods as a discriminated union: `github_token`, `github_oauth`, `pairing`, `challenge`, `apikey`, and `open`.

## Package naming

- `@kraki/head` installs the `kraki-relay` CLI
- `@kraki/tentacle` installs the `kraki` CLI

## Links

- Main docs: `https://github.com/corelli18512/kraki/blob/main/README.md`
- Security model: `https://github.com/corelli18512/kraki/blob/main/SECURITY.md`
