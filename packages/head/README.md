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

By default the relay uses `open` auth, listens on `ws://127.0.0.1:4000` (this machine only) and stores user/device data in `kraki-head.db`.

`open` auth without a shared key refuses to listen on a non-loopback `HOST` / `--host`, because anyone who reached it could drive your computers. To accept other machines, set `OPEN_SHARED_KEY` (computers send it from `~/.kraki/channel.key`) or use `--auth github` / `--auth apikey`. See the [self-hosting guide](../../docs/self-hosting.md#reaching-the-relay-from-other-machines).

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

## Diagnostic log collection is a separate service

Client diagnostic metadata is collected by [`@kraki/monitor`](../monitor/README.md),
not this relay. Route `/api/diag/v1/*` to the independent collector (default
loopback port4011). Head returns404 for these paths and no longer embeds a
collector when `KRAKI_DIAG_DIR` is set. Existing embedded-mode deployments must
move that route to Monitor before upgrading Head; independent `kraki-diag`
deployments do not require a Head restart. See Monitor's migration instructions.

## Health and metrics

- `GET /` — liveness: `{"name":"@kraki/head","version":…,"status":"ok"}` while the process runs.
- `GET /health/ready` — readiness: `200 {"status":"ready"}` only when the database
  answers a query, the 30 s health tick is running (event loop not stuck) and every
  push provider in `PUSH_PROVIDERS` loaded; otherwise `503 {"status":"not_ready","checks":…}`
  naming the failed check. Point uptime monitors here.
- `GET /internal/metrics` — counters and timings for independently managed
  host monitoring: connections, auth ok/failed by code,
  pulse frames and bytes in/out, forwarded messages, push sent/failed, account API
  requests, and how long the relay takes to handle one frame (histogram). Counts only: no device, user, IP
  or payload data. Answers **direct loopback requests only**; anything that came
  through a reverse proxy (any forwarding header) or from another address gets 404.
- The log carries a `health` line (connections, memory, durable rows, event-loop
  delay `evlLagMs` p99 / `evlMaxMs` beyond the 20 ms sampling interval, `upSec`, and
  on the account service `apiReq` / `apiErr` since the previous line). It is sampled
  every 30 s and logged when connections, endpoints, durable rows or RSS (±10 MB)
  change or the loop stalled ≥ 100 ms, otherwise every 5 minutes.
- The account service logs one `Account API request` line per request (status,
  `ms`, caller, device) under the `X-Kraki-Request-Id` an edge sends and logs with
  its own outcome.

## Useful options

```bash
kraki-relay --port 8080
OPEN_SHARED_KEY=<secret> kraki-relay --host 0.0.0.0
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
