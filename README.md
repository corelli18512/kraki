<p align="center">
  <img src="./logo.png" alt="Kraki" width="140">
</p>

<h1 align="center">Kraki</h1>

<p align="center"><strong>A native chat app for your coding agents — every agent, every machine, one app.</strong></p>

<p align="center">
  <a href="https://kraki.chat">Website</a> ·
  <a href="https://kraki.chat/docs/">Docs</a> ·
  <a href="https://github.com/corelli18512/kraki/discussions">Discussions</a> ·
  <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <a href="https://github.com/corelli18512/kraki/actions/workflows/ci.yml"><img src="https://github.com/corelli18512/kraki/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://kraki.chat/shots/mac-dark-20261126.jpg">
    <img src="https://kraki.chat/shots/mac-light-20261126.jpg" alt="Kraki for Mac: sessions from several computers and agents in one window" width="860">
  </picture>
</p>

Kraki brings **Claude Code, Codex, GitHub Copilot and Pi** — running on all your computers — into one
chat app. Follow what your agents are doing, approve tool calls, answer their questions and send the
next instruction (by voice, too) from your Mac, iPhone, PC or any browser. Step away from the desk
and keep your agents moving.

- **Every agent, every machine.** Sessions from your work laptop, your home desktop and every agent
  on them, in one list.
- **Approve from anywhere.** A notification when an agent needs you; answer its questions, and in
  Safe mode approve or deny each change, from your phone.
- **Native, not a chat box in a browser.** Mac and iPhone apps with code, diffs, tables and live
  tool activity, and voice input that knows your code.
- **Zero network setup.** No ports, VPN or tunnels: each computer makes one outbound connection.
  Conversations are end-to-end encrypted between your devices. Run your own relay if you prefer.

## Get Kraki

| | |
| --- | --- |
| **Mac** | [Download Kraki for Mac](https://kraki.chat/download/mac) — macOS 15+, Apple silicon and Intel. Finds your agents and signs you in; no Terminal needed. |
| **iPhone** | [Download on the App Store](https://apps.apple.com/app/kraki/id6799694476) — iOS 18 or later. |
| **Windows** (preview) | [Download Kraki for Windows](https://kraki.chat/download/windows) — Windows 10/11 x64. The installer isn't signed yet: choose *More info → Run anyway*. |
| **Any phone or browser** | [app.kraki.chat](https://app.kraki.chat) — add it to your home screen for notifications. |
| **Linux / command line** | See below. |

Install Kraki on each computer whose agents you want to use (Kraki for Mac, Kraki for Windows, or the
command-line version), then add your phone by scanning the QR code it shows.

```bash
# macOS / Linux
curl -fsSL https://app.kraki.chat/install.sh | bash

# Windows (PowerShell)
irm https://app.kraki.chat/install.ps1 | iex

# or with npm
npm i -g @kraki/tentacle
kraki
```

On first run the command-line version checks the coding agents on this computer, signs you in with
GitHub, starts in the background and shows a QR code for your phone. Run `kraki agents` any time to
recheck your agents. Binaries are also on the [releases page](https://github.com/corelli18512/kraki/releases/latest).

### Uninstall the command-line version

```bash
kraki stop        # stops Kraki and removes its login item (launchd job / Windows Run entry)
```

Then remove what the installer put on the computer:

- **macOS:** `rm -rf ~/.local/share/kraki/Kraki.app ~/.local/bin/kraki ~/Library/LaunchAgents/cloud.corelli.kraki.plist` (`kraki stop` removes the login item only while Kraki is running)
- **Linux:** `rm ~/.local/bin/kraki` (`/usr/local/bin/kraki` for a global install)
- **Windows:** `Remove-Item -Recurse "$env:LOCALAPPDATA\Kraki"`, and remove that folder from your user `Path`
- **npm:** `npm uninstall -g @kraki/tentacle`

On macOS and Linux the installer may have added `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`, `~/.bash_profile` or `~/.bashrc`; delete that line if nothing else uses it.

Kraki's data (sessions, sign-in, this computer's identity) stays in `~/.kraki` (Windows: `%USERPROFILE%\.kraki`); delete that folder to remove it too. "Delete all Kraki data…" in `kraki` moves it to the Trash on macOS and to `~/.kraki.deleted-<date>` elsewhere, so it can be recovered; delete that folder to free the space. Your agents' own files are never touched.

More: [install and troubleshooting](https://kraki.chat/docs/) ·
[run your own relay](./docs/self-hosting.md) · [security model](./docs/security.md)

## How it works

```text
Agent <-> tentacle -- WebSocket --> head -- WebSocket --> arm
```

1. `tentacle` listens to agent events on the machine doing the work, encrypts them, and sends them to `head`.
2. `head` authenticates devices and forwards encrypted payloads over a reliable transport (pulse). It cannot read message contents.
3. `arm` decrypts messages, shows sessions, and sends approvals, answers, and user input back to the right machine.

Tentacle buffers messages and handles replay on reconnect so sessions recover cleanly after temporary disconnects.

## Security at a glance

Kraki is always end-to-end encrypted. The relay sees pulse frame headers, envelope type, destination device ID, sender device ID, and payload size. Everything else — message content, session IDs, tool names, user input — is inside the encrypted payload.

The relay stores only a users table and a devices table. No messages, no sessions, no content.

For the full security model, see [`docs/security.md`](./docs/security.md).

## Repository guide

- `packages/tentacle` - the `kraki` CLI and background service next to your agents
- `packages/head` - thin relay server
- `packages/protocol`, `packages/crypto`, `packages/pulse` - shared message types, encryption and the reliable transport
- `packages/arm/web` - web app / PWA (also the UI of Kraki for Windows)
- `packages/arm/ios` - Kraki for Mac and the iPhone app
- `packages/desktop` - Kraki for Windows (Electron shell)
- `packages/voice-broker` - cloud voice gateway
- [`packages/monitor`](packages/monitor/README.md) - independent client diagnostic log REST collector (not the relay)
- `packages/tests` - integration tests

For the runtime design, see [`docs/architecture.md`](./docs/architecture.md).

## Development

```bash
git clone https://github.com/corelli18512/kraki.git
cd kraki
pnpm install

# Full TypeScript regression (not necessary after every edit)
pnpm validate
```

Prefer focused checks for the changed component. See [test scope and device safety](./docs/testing.md)
for isolated native tests and explicitly opt-in performance/hardware acceptance.

Everything a person can do with Kraki is listed in [`FEATURES.md`](./FEATURES.md): add or update its
row when a change adds or changes something people see. Before big releases, run the full manual pass
in [`QA-TEMPLATE.md`](./QA-TEMPLATE.md).

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

Kraki's security guarantees are limited to the model described in [`docs/security.md`](./docs/security.md). The relay cannot read message bodies, but that does not cover endpoint compromise, company policy, network monitoring, logging, data residency, or other organizational controls.

You are responsible for deciding whether Kraki is appropriate for your environment. If you plan to use it with company-managed devices, repositories, or networks, review your organization's policies and consult your security / IT team before using it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems: [SECURITY.md](SECURITY.md).

## License

MIT
