<p align="center">
  <a href="https://github.com/corelli18512/kraki">
    <img src="https://raw.githubusercontent.com/corelli18512/kraki/main/logo.png" alt="Kraki" width="140">
  </a>
</p>

<p align="center">
  <a href="https://github.com/corelli18512/kraki">GitHub repository</a>
</p>

# @kraki/head

Relay server that routes messages between tentacles and apps.

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

By default the relay listens on `ws://localhost:4000` and stores data in `kraki-head.db`.

Enable GitHub login for the web app:

```bash
GITHUB_CLIENT_ID=your_client_id \
GITHUB_CLIENT_SECRET=your_client_secret \
npx @kraki/head --auth github --e2e true
```

## Useful options

```bash
kraki-relay --port 8080
kraki-relay --db /path/to/kraki-head.db
kraki-relay --auth open
kraki-relay --auth github --e2e true
kraki-relay --log debug
```

## Package naming

- `@kraki/head` installs the `kraki-relay` CLI
- `@kraki/tentacle` installs the `kraki` CLI

## Links

- Main docs: `https://github.com/corelli18512/kraki/blob/main/README.md`
- Security model: `https://github.com/corelli18512/kraki/blob/main/SECURITY.md`
