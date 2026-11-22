# Self-Hosting Kraki

Run your own relay instead of using the hosted one at `relay.kraki.chat`.

> **Self-hosting is unsupported and at your own risk.** The official iOS and Mac apps only trust Kraki's own relays (`wss://*.kraki.chat`). Two things to know before pointing a computer at someone else's relay:
>
> - With GitHub sign-in, the relay verifies your GitHub token itself, so whoever runs it receives that token (scope `read:user`: your public profile). `kraki` warns about this during setup.
> - Conversations stay end-to-end encrypted, but a relay operator controls which devices are on your account (see [security.md](./security.md)).

## Start the relay

```bash
npx @kraki/head

# or
npm i -g @kraki/head
kraki-relay
```

By default the relay uses `open` auth and listens on `ws://127.0.0.1:4000`, reachable from this machine only. It stores user, device and delivery data, but never readable messages or sessions (see [security.md](./security.md#what-the-relay-stores)).

Then run kraki on the coding machine and point it at your relay URL instead of the hosted default.

## Reaching the relay from other machines

With `open` auth and no shared key, anyone who can reach the relay joins your account and can drive your computers. So in that mode the relay only listens on loopback, and it refuses to start with a non-loopback `KRAKI_HOST` / `--host` (for example `0.0.0.0`). To serve other machines, pick one:

- **Shared key (open auth).** Set a long random secret on the relay and put the same secret in `~/.kraki/channel.key` (`chmod 600`) on each computer before running `kraki`:

  ```bash
  OPEN_SHARED_KEY=$(openssl rand -hex 32) KRAKI_HOST=0.0.0.0 kraki-relay
  ```

  Every `open` sign-in and every pairing (QR) request must then carry the key. Computers send it from `channel.key`. Apps join by scanning the computer's QR code. Older `kraki` versions connect with the key, but they can't make QR codes on a keyed relay; update `kraki` for that.
- **GitHub or API-key auth** (`--auth github`, `--auth apikey`). These modes keep listening on all interfaces unless you set `KRAKI_HOST` or `--host`.

A reverse proxy (nginx, Caddy, …) makes the relay public, even when it runs on the same host and points at `127.0.0.1:4000`. So behind a proxy, always set `OPEN_SHARED_KEY` or use GitHub or API-key auth. Without a key, the relay refuses `open` sign-ins and pairing requests that came through a proxy (they carry `X-Forwarded-For`, `Forwarded` or `X-Real-IP`). A proxy that sends none of these headers looks like a local client, so don't rely on that check: set the key.

## Enable GitHub Login for the web app

By default, users connect the web app via QR code pairing from the terminal. You can also enable "Sign in with GitHub":

1. Create a GitHub OAuth App at **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set the **Authorization callback URL** to your web app URL (e.g., `https://your-domain.com` or `http://localhost:3000`)
3. Set the environment variables on your relay server:

```bash
GITHUB_CLIENT_ID=your_client_id \
GITHUB_CLIENT_SECRET=your_client_secret \
kraki-relay --auth github
```

The web app will automatically show a "Sign in with GitHub" button when the relay has OAuth configured. QR pairing continues to work alongside GitHub login.

## Enable push notifications

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

The relay only sends to subscriptions on the browser push services (https on FCM, Mozilla autopush, Apple Web Push or WNS). It refuses other endpoints when they are registered, and drops older stored ones at send time.

## Local web development

For local web development, put browser-only overrides like `VITE_WS_URL=ws://localhost:4000` in `packages/arm/web/.env.development.local`, not `packages/arm/web/.env`. Vite loads `.env` during production builds too, so using the dev-only filename avoids accidentally baking localhost into a deploy.

## Updating a running relay

When you're hosting `@kraki/head` long-term as a systemd service, `scripts/deploy-edge-relay.sh` updates it and rolls it back safely. It is what Kraki's own relays use.

### One-time setup

The script expects each Head version in its own directory, with a systemd drop-in choosing which one runs:

- `/etc/kraki/relay.env` is the canonical config, `chmod 600` and owned by root, referenced from the unit's `EnvironmentFile=`. Keep secrets out of the release directories. It holds the auth settings for a public relay (`OPEN_SHARED_KEY`, or `AUTH_MODE=github` / `apikey` with their keys; see [Reaching the relay from other machines](#reaching-the-relay-from-other-machines)) plus any optional features you've enabled (GitHub OAuth, push, multi-region edge config).
- Each release is its own `npm --prefix` install under `/opt/kraki-head/releases/<version>`:

  ```bash
  sudo npm --prefix /opt/kraki-head/releases/0.22.0 install --omit=dev @kraki/head@0.22.0
  ```

- The base unit, and a drop-in whose `ExecStart` runs one release with an absolute node path (the script installs with the `npm` next to that node):

  ```ini
  # /etc/systemd/system/kraki-relay.service
  [Service]
  EnvironmentFile=/etc/kraki/relay.env
  KillSignal=SIGTERM
  TimeoutStopSec=15
  Restart=on-failure
  RestartSec=5

  # /etc/systemd/system/kraki-relay.service.d/zzz-head-release.conf
  [Service]
  ExecStart=
  ExecStart="/usr/bin/node" "/opt/kraki-head/releases/0.22.0/node_modules/@kraki/head/dist/cli.js" "--port" "4000" "--db" "/var/lib/kraki/kraki-relay.db"
  ```

The relay listens on `127.0.0.1:<port>` (4000 when the drop-in has no `--port`), with nginx or similar in front for TLS.

### Deploying a new version

Run on the relay host, as root:

```bash
sudo bash scripts/deploy-edge-relay.sh <version>        # e.g. 0.22.0
# or from your machine, without a checkout on the host:
ssh <host> 'sudo bash -s <version>' < scripts/deploy-edge-relay.sh
```

It:

1. Reads the running release, node and database from the drop-in, and refuses a host without this layout.
2. Takes a WAL-safe snapshot of the live DB (`sqlite3 .backup`) to `/opt/kraki-head/backups/head-pre-<version>-<timestamp>.db`, checks it with `PRAGMA integrity_check`, and saves the current drop-in as `/opt/kraki-head/backups/zzz-head-release.conf.<previous version>`.
3. Installs `@kraki/head@<version>` into `/opt/kraki-head/releases/<version>` with `npm --prefix`, checks the installed version and that `better-sqlite3` loads under the unit's node. The previous release directory stays.
4. Points the drop-in's `ExecStart` at the new release, tells `/usr/local/bin/kraki-watch` (if installed) about the planned restart, then `systemctl daemon-reload` and `systemctl restart kraki-relay`.
5. Verifies that the service is active, that `http://127.0.0.1:<port>/` and `/healthz` report the new version, and that a WebSocket upgrade gets `101`. With `KRAKI_PUBLIC_URL=https://<your relay>` it also checks `/healthz` and the upgrade through the proxy.
6. If the restart or any check fails, restores the previous drop-in, restarts and verifies the previous version. It doesn't restore the database: if the new version changed the schema (`PRAGMA user_version`), it says so and names the snapshot.

Nothing on the service changes until the snapshot, the integrity check and the install have succeeded.

The script pins `npm install` to `https://registry.npmjs.org` so it doesn't see stale versions from mirrors (e.g. `registry.npmmirror.com`, common on Chinese edge hosts, can lag the upstream registry by hours). Override via `NPM_REGISTRY=...` if you need to install from a different source.

### Rolling back

```bash
sudo bash scripts/deploy-edge-relay.sh rollback <version>   # e.g. 0.21.0
```

Switches back to the saved drop-in of a release that is still installed, restarts and verifies it the same way. The drop-in it replaces is saved too, so you can roll forward again with `rollback <newer version>`. Without a saved drop-in for that version it lists the saved ones.

`scripts/deploy-edge-relay.test.mjs` runs the script against a fake root (`KRAKI_DEPLOY_ROOT`) with fake `systemctl`, `curl`, `sqlite3` and `npm`; CI runs it and `shellcheck` on every change. Never set `KRAKI_DEPLOY_ROOT` on a relay.

### Daily database backups

Backup scheduling, retention, off-site storage and notification delivery belong
to the operator's infrastructure, not the product build. The previously bundled
personal backup/monitoring tools are maintained separately; Kraki does not install
or schedule them. See [the operations boundary](operations-boundary.md).

Use SQLite's online backup API or `sqlite3 .backup` for a consistent snapshot of
the running database; do not copy only the main file while WAL writes are active.
Run `PRAGMA integrity_check` on each snapshot before accepting it. Keep snapshots
and configuration backups private, enforce a retention policy, verify off-site
copies and periodically restore into an isolated test environment. An upgrade
snapshot does not replace scheduled backups. Never overwrite a live database
with an older snapshot as part of a code rollback.

### Capping journald

If you're seeing the relay's journal grow without bound, cap it system-wide:

```ini
# /etc/systemd/journald.conf
SystemMaxUse=200M
SystemMaxFileSize=50M
MaxRetentionSec=2week
```

Then `sudo systemctl restart systemd-journald`. This only affects log writes and does not disturb the relay process.
