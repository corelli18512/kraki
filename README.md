<p align="center">
  <img src="./logo.png" alt="Kraki" width="160">
</p>

<h1 align="center">Kraki</h1>

<p align="center"><strong>Control your coding agents from your phone</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/status-preview-orange" alt="Preview">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/E2E-AES--256--GCM-green?logo=letsencrypt&logoColor=white" alt="E2E Encrypted">
  <a href="https://github.com/corelli18512/kraki/actions/workflows/ci.yml"><img src="https://github.com/corelli18512/kraki/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

> 🐣 **Preview:** Kraki is early-stage. Currently supports GitHub Copilot CLI only. Expect breaking changes.

Kraki bridges your coding agent to your phone or browser. Watch sessions in real time, approve tool calls, answer questions, and send follow-up instructions — from anywhere, on any device. All traffic is end-to-end encrypted.

Install with one command:

```bash
# macOS / Linux
curl -fsSL https://kraki.corelli.cloud/install.sh | bash

# Windows (PowerShell)
irm https://kraki.corelli.cloud/install.ps1 | iex

# or with npm
npm i -g @kraki/tentacle
kraki
```

## You need Kraki if

- **You want to step away from the desk** but keep steering the agent. Approve tool calls, answer questions, and send follow-ups from your phone while the agent keeps working.
- **Zero network setup.** No port forwarding, no VPN, no tunnels. The relay is end-to-end encrypted — it can't read your code — so you don't need to self-host to stay safe.
- **You want more than a chat box.** A purpose-built interface for interactive coding agents — code diffs, tool approval flows, structured prompts, and session history.
- **You work across multiple machines** and want one place to see all agent sessions from your phone or browser.

## Set up

```bash
# macOS / Linux
curl -fsSL https://kraki.corelli.cloud/install.sh | bash

# Windows (PowerShell)
irm https://kraki.corelli.cloud/install.ps1 | iex

# or with npm (all platforms)
npm i -g @kraki/tentacle
kraki
```

Or [download the binary manually](https://github.com/corelli18512/kraki/releases/latest) — on macOS/Linux, run `chmod +x ./kraki-cli-*` first.

> Note: macOS may show Gatekeeper and Windows may show SmartScreen on first launch. If you trust the release, use "Open Anyway" / "Run anyway".

On first run, Kraki will:

1. guide you through setup in the terminal
2. connect to the hosted relay by default
3. show a QR code / pairing flow for your browser or phone

> 📲 **Tip:** On your phone, open the web app in Safari or Chrome and use "Add to Home Screen" to install it as a PWA. You get push notifications, full-screen mode, and instant access without opening a browser.

### Self-host your own relay

See [SELF-HOSTING.md](./SELF-HOSTING.md) for relay setup, GitHub login, and push notification configuration.

## How it works

```text
Agent <-> tentacle -- WebSocket --> head -- WebSocket --> arm
```

1. `tentacle` listens to agent events on the machine doing the work, encrypts them, and sends them to `head`.
2. `head` authenticates devices and forwards encrypted blobs to the right connections. It cannot read message contents.
3. `arm` decrypts messages, shows sessions, and sends approvals, answers, and user input back to the right machine.

Tentacle buffers messages and handles replay on reconnect so sessions recover cleanly after temporary disconnects.

## Security at a glance

Kraki is always end-to-end encrypted. The relay sees envelope type, destination device ID, sender device ID, and blob size. Everything else — message content, session IDs, tool names, user input — is inside the encrypted blob.

The relay stores only a users table and a devices table. No messages, no sessions, no content.

For the full security model, see [`SECURITY.md`](./SECURITY.md).

## Repository guide

- `packages/protocol` - shared message and envelope types
- `packages/crypto` - encryption primitives and blob helpers
- `packages/head` - thin relay server
- `packages/tentacle` - CLI bridge next to the agent
- `packages/arm/web` - web receiver / PWA
- `packages/tests` - integration tests

For the runtime design, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Development

```bash
git clone https://github.com/corelli18512/kraki.git
cd kraki
pnpm install

# Validate the repo
pnpm validate
```

### Run the pieces individually

```bash
pnpm dev:head       # relay on ws://localhost:4000 (GitHub auth, E2E, pairing)
pnpm dev:tentacle   # CLI bridge (connects to relay, bridges agent events)
pnpm dev:web        # web app → auto-pairs with prod relay, opens Chrome
```

### Web app against a local relay

```bash
pnpm dev:web --local-relay   # web app → ws://localhost:4000
```

### All-in-one local dev

```bash
pnpm dev
```

Starts a real local stack in one command:

- local `head` on `ws://localhost:4000`
- the real Kraki daemon with isolated state under `.tmp/kraki-local`
- the real local web app with a stable pairing entry URL

It prints the local entry URL, log directory, and SQLite DB path, then opens the browser automatically. This is the fastest way to do end-to-end local feature testing without touching your real `~/.kraki` state.

Useful helpers:

```bash
pnpm dev:logs    # tail local stack logs
pnpm dev:stop    # stop the local stack
pnpm dev:reset   # stop + delete .tmp/kraki-local
pnpm dev:demo          # old mock tentacle / REPL demo flow
```

## Company / enterprise use

Kraki's security guarantees are limited to the model described in [`SECURITY.md`](./SECURITY.md). The relay cannot read message bodies, but that does not cover endpoint compromise, company policy, network monitoring, logging, data residency, or other organizational controls.

You are responsible for deciding whether Kraki is appropriate for your environment. If you plan to use it with company-managed devices, repositories, or networks, review your organization's policies and consult your security / IT team before using it.

## License

MIT
