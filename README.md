<p align="center">
  <img src="./logo.png" alt="Kraki" width="160">
</p>

<h1 align="center">Kraki</h1>

<p align="center"><strong>Remote control for coding agents from anywhere through an E2E encrypted relay</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/status-preview-orange" alt="Preview">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/@kraki/tentacle"><img src="https://img.shields.io/npm/v/@kraki/tentacle" alt="npm"></a>
  <img src="https://img.shields.io/badge/E2E-AES--256--GCM-green?logo=letsencrypt&logoColor=white" alt="E2E Encrypted">
  <a href="https://github.com/corelli18512/kraki/actions/workflows/ci.yml"><img src="https://github.com/corelli18512/kraki/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white" alt="TypeScript">
</p>

> 🐣 **Preview:** Kraki is still in early stage. Expect breaking changes, rough edges, and setup/docs updates while the core flows stabilize.

Kraki lets you watch agent sessions, respond to permission requests, answer questions, and send follow-up input from a phone or browser while the agent keeps running on another machine.

Get started on your coding machine:

- [Download the latest standalone binary from GitHub Releases](https://github.com/corelli18512/kraki/releases/latest)
- Or install from npm:
```bash 
npm i -g @kraki/tentacle
# then
kraki
```
- Only supports GitHub Copilot CLI and GitHub account login for now
- On macOS/Linux, if the downloaded binary is not executable yet, run `chmod +x ./kraki-<platform>-<arch>` once

Kraki is a little sea creature with a job: the `head` stays in the middle, the `tentacles` reach your agent machines, and the `arms` hold the devices you use to watch and steer the work:

- `tentacle` runs next to the agent
- `head` forwards encrypted messages
- `arm` gives you a UI on another device


## Why Kraki?

- **End-to-end encrypted.** The relay forwards your sessions without being able to read message bodies. There is no unencrypted mode.
- **Keep one view across multiple machines.** A single relay can aggregate sessions from several computers and forward them to several receiving devices.
- **Use another device as your control surface.** Check progress, approve actions, and answer prompts -- same experience of interactive coding agents without sitting in front of the machine.
- **Built to grow.** The protocol, crypto layer, and adapter boundary are designed so more agents and clients can be added over time.
- **Self-host if you want control.** You can run your own relay easily — it is just auth and forward.

## What ships today

- Relay server (`head`) — thin encrypted forwarder
- CLI bridge for agent machines (`tentacle`)
- Web receiver / PWA (`arm/web`) with push notifications
- Shared protocol and crypto packages
- Current adapter work centered on Copilot-based flows

Native iOS and additional agent adapters will be added later without changing the core message flow. Any feedback and contributions are welcome.

## Set up

Install Kraki on the coding machine:

- Preferred: [Download the latest standalone binary from GitHub Releases](https://github.com/corelli18512/kraki/releases/latest) and run the matching `kraki-*` asset for your platform
- Or install from npm: `npm i -g @kraki/tentacle`, then run `kraki`
- On macOS/Linux, if the downloaded binary is not executable yet, run `chmod +x ./kraki-<platform>-<arch>` once

> Note: macOS may show Gatekeeper and Windows may show SmartScreen on first launch. If you trust the release, use "Open Anyway" / "Run anyway".

On first run, Kraki will:

1. guide you through setup in the terminal
2. connect to the hosted relay by default
3. show a QR code / pairing flow for your browser or phone

> 📲 **Tip:** On your phone, open the web app in Safari or Chrome and use "Add to Home Screen" to install it as a PWA. You get push notifications, full-screen mode, and instant access without opening a browser.

Package names and executables are different on purpose:

- `@kraki/tentacle` installs the `kraki` CLI
- `@kraki/head` installs the `kraki-relay` CLI

### Self-host your own relay

Start the relay:

```bash
npx @kraki/head

# or
npm i -g @kraki/head
kraki-relay
```

By default the relay listens on `ws://localhost:4000`. It stores only user and device data — no messages, no sessions.

Then run the same tentacle setup flow on the coding machine, but point it at your relay URL instead of the hosted default.

### Enable GitHub Login for the web app

By default, users connect the web app via QR code pairing from the terminal. You can also enable "Sign in with GitHub" for the web app:

1. Create a GitHub OAuth App at **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set the **Authorization callback URL** to your web app URL (e.g., `https://kraki.corelli.cloud` or `http://localhost:3000`)
3. Set the environment variables on your relay server:

```bash
GITHUB_CLIENT_ID=your_client_id \
GITHUB_CLIENT_SECRET=your_client_secret \
kraki-relay --auth github
```

The web app will automatically show a "Sign in with GitHub" button when the relay has OAuth configured. QR pairing continues to work alongside GitHub login.

### Enable push notifications

The relay can send push notifications to offline browsers when agents need attention (permissions, questions, turn completions). Notifications are end-to-end encrypted — the relay forwards an opaque blob, and the browser's service worker decrypts it locally.

1. Generate VAPID keys (one-time):

```bash
npx web-push generate-vapid-keys
```

2. Set the environment variables on your relay server:

```bash
VAPID_PUBLIC_KEY=your_public_key \
VAPID_PRIVATE_KEY=your_private_key \
VAPID_EMAIL=mailto:you@example.com \
kraki-relay --push web_push
```

The web app will automatically show a "Push notifications" toggle in Settings when the relay has VAPID configured.

For local web development, put browser-only overrides like `VITE_WS_URL=ws://localhost:4000` in `packages/arm/web/.env.development.local`, not `packages/arm/web/.env`. Vite loads `.env` during production builds too, so using the dev-only filename avoids accidentally baking localhost into a deploy.

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
