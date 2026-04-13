<p align="center">
  <a href="https://github.com/corelli18512/kraki">
    <img src="https://raw.githubusercontent.com/corelli18512/kraki/main/logo.png" alt="Kraki" width="140">
  </a>
</p>

<p align="center">
  <a href="https://github.com/corelli18512/kraki">GitHub repository</a>
</p>

# Kraki

CLI bridge that connects your coding machine to Kraki.

> Preview: Kraki is still early-stage. Expect breaking changes while the core flows stabilize.

Kraki runs next to your coding agent, connects to a relay, and lets you watch and steer sessions from your phone or another device.

Right now the main supported agent flow is GitHub Copilot CLI.

## Install

Download the binary for your platform from [GitHub Releases](https://github.com/corelli18512/kraki/releases/latest):

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `kraki-cli-macos-arm64` |
| macOS (Intel) | `kraki-cli-macos-x64` |
| Linux (x64) | `kraki-cli-linux-x64` |
| Windows (x64) | `kraki-cli-windows-x64.exe` |

```bash
# macOS / Linux
chmod +x kraki-cli-*
./kraki-cli-macos-arm64   # or the binary for your platform

# Windows
kraki-cli-windows-x64.exe
```

## Requirements

- GitHub Copilot CLI installed on the coding machine
- A browser or phone to connect to the Kraki web app

## Quick start

1. Download and run the binary
2. Follow the setup prompts in the terminal
3. By default it connects to the hosted relay
4. Scan the QR code or open the web app to connect your browser or phone

The hosted web app lives at:

- `https://kraki.corelli.cloud`

## What tentacle handles

Beyond bridging agent events, tentacle is responsible for several things that used to live on the relay:

- **Sequence numbers and timestamps** — assigned locally by tentacle, not by the relay
- **Message buffering** — tentacle buffers messages and handles replay when devices reconnect
- **Session lifecycle** — session create, update, and close are managed here
- **Auto-approval** — tools on a local allowed list are approved automatically without user interaction
- **Encryption** — all outgoing messages are encrypted before leaving the machine

The relay is a thin forwarder. Tentacle and the frontend own the application logic.

## Useful commands

```bash
kraki          # start the tentacle / setup flow
kraki status   # show daemon + relay status
kraki connect  # generate a fresh QR code / pairing link
kraki stop     # stop the local daemon
```

## Use your own relay

Start a relay with `@kraki/head`:

```bash
npx @kraki/head

# or
npm i -g @kraki/head
kraki-relay
```

Then point tentacle setup at your own relay URL instead of the hosted default.

## Links

- Main docs: `https://github.com/corelli18512/kraki/blob/main/README.md`
- Security model: `https://github.com/corelli18512/kraki/blob/main/SECURITY.md`
