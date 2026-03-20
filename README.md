<p align="center">
  <img src="./logo.png" alt="Kraki" width="160">
</p>

<h1 align="center">Kraki</h1>

<p align="center"><strong>Remote control for coding agents from anywhere through an E2E encrypted relay</strong></p>

Kraki lets you watch agent sessions, respond to permission requests, answer questions, and send follow-up input from a phone or browser while the agent keeps running on another machine. 

Get started on your coding machine:
```bash
# Only supports Github Copilot CLI for now
# Requires Copilot CLI installed and `gh auth login` completed
npx kraki
```

Kraki is a little sea creature with a job: the `head` stays in the middle, the `tentacles` reach your agent machines, and the `arms` hold the devices you use to watch and steer the work:

- `tentacle` runs next to the agent
- `head` routes and stores messages
- `arm` gives you a UI on another device


## Why Kraki?

- **End-to-end encrypted by default.** The relay can forward your sessions without being able to read message bodies.
- **Keep one view across multiple machines.** A single relay can aggregate sessions from several computers and forward them to several receiving devices.
- **Use another device as your control surface.** Check progress, approve actions, and answer prompts -- same experience of interactive coding agents without sitting in front of the machine.
- **Built to grow.** The protocol, crypto layer, and adapter boundary are designed so more agents and clients can be added over time.
- **Self-host if you want control.** You can run your own server easily and switch operating mode when that fits better.

## What ships today

- Relay server (`head`)
- CLI bridge for agent machines (`tentacle`)
- Web receiver / PWA (`arm/web`)
- Shared protocol and crypto packages
- Current adapter work centered on Copilot-based flows

Native iOS and additional agent adapters will be added later without changing the core message flow. Any feedback and contributions are welcome.

## Quick start

```bash
npx kraki
```

On first run, Kraki guides setup, connects to the hosted relay, and shows a QR code / pairing flow for your browser or phone.

### Self-host your own relay

```bash
npx kraki-relay
```

By default the relay listens on `ws://localhost:4000`.

After the relay is running, use the same CLI flow on the coding machine:

During setup, point the CLI at your relay URL instead of the hosted default.

### Enable GitHub Login for the web app

By default, users connect the web app via QR code pairing from the terminal. You can also enable "Sign in with GitHub" for the web app:

1. Create a GitHub OAuth App at **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set the **Authorization callback URL** to your web app URL (e.g., `https://kraki.corelli.cloud` or `http://localhost:3000`)
3. Set the environment variables on your relay server:

```bash
GITHUB_CLIENT_ID=your_client_id \
GITHUB_CLIENT_SECRET=your_client_secret \
npx kraki-relay --auth github
```

The web app will automatically show a "Sign in with GitHub" button when the relay has OAuth configured. QR pairing continues to work alongside GitHub login.

## How it works

```text
Agent <-> tentacle -- WebSocket --> head -- WebSocket --> arm
```

1. `tentacle` listens to agent events on the machine doing the work.
2. `head` authenticates devices, routes messages, and stores replay history.
3. `arm` shows sessions and sends approvals, answers, and user input back to the right machine.

On reconnect, clients ask for everything after their last seen sequence number, so sessions recover cleanly after temporary disconnects.

## Security at a glance

Kraki supports two operating modes:

| Mode | Who can read message content? | Good fit for |
|------|-------------------------------|--------------|
| End-to-end encrypted | Only participating devices | The default hosted experience, or any relay you do not fully trust |
| Trusted self-hosted | The relay operator | Simple private deployments you control |

Even in end-to-end encrypted mode, the relay still sees some metadata needed to route traffic, such as device IDs, timestamps, message sizes, recipient lists, and limited session hints.

For the full security model, see [`SECURITY.md`](./SECURITY.md).

## Repository guide

- `packages/protocol` - shared message types
- `packages/crypto` - encryption primitives and helpers
- `packages/head` - relay server
- `packages/tentacle` - CLI bridge next to the agent
- `packages/arm/web` - web receiver / PWA
- `packages/tests` - integration tests

For the runtime design, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Development

```bash
git clone https://github.com/user/kraki.git
cd kraki
pnpm install

# Validate the repo
pnpm validate

# Run the pieces locally
pnpm dev:head
pnpm dev:tentacle
pnpm dev:web
```

## Company / enterprise use

Kraki's security guarantees are limited to the model described in [`SECURITY.md`](./SECURITY.md). In end-to-end encrypted mode, the relay cannot read message bodies, but that does not cover endpoint compromise, company policy, network monitoring, logging, data residency, or other organizational controls.

You are responsible for deciding whether Kraki is appropriate for your environment. If you plan to use it with company-managed devices, repositories, or networks, review your organization's policies and consult your security / IT team before using it.

## License

MIT
