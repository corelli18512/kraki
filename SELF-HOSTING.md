# Self-Hosting Kraki

Run your own relay instead of using the hosted one at `kraki.corelli.cloud`.

## Start the relay

```bash
npx @kraki/head

# or
npm i -g @kraki/head
kraki-relay
```

By default the relay listens on `ws://localhost:4000`. It stores only user and device data — no messages, no sessions.

Then run kraki on the coding machine and point it at your relay URL instead of the hosted default.

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

## Local web development

For local web development, put browser-only overrides like `VITE_WS_URL=ws://localhost:4000` in `packages/arm/web/.env.development.local`, not `packages/arm/web/.env`. Vite loads `.env` during production builds too, so using the dev-only filename avoids accidentally baking localhost into a deploy.

## Updating a running relay

When you're hosting `@kraki/head` long-term as a systemd service, use the helper scripts under `scripts/` to update and back up the relay safely.

### One-time setup

Make `/etc/kraki/relay.env` the canonical config and reference it from systemd. **Do not** keep secrets inside the npm package directory — `npm install -g @kraki/head@X` wipes the package contents on every upgrade and would take your config with it.

```ini
# /etc/systemd/system/kraki-relay.service
[Service]
EnvironmentFile=/etc/kraki/relay.env
ExecStart=/usr/local/bin/kraki-relay --port 4000 --db /var/lib/kraki/kraki-relay.db
KillSignal=SIGTERM
TimeoutStopSec=15
Restart=on-failure
RestartSec=5
```

`/etc/kraki/relay.env` should be `chmod 600`, owned by root, and contain at minimum the keys listed under "Start the relay" plus any optional features you've enabled (GitHub OAuth, push, multi-region edge config).

### Deploying a new version

`scripts/deploy-edge-relay.sh <version>` runs the full upgrade on the relay host. It:

1. Takes a WAL-safe SQLite snapshot of the live DB plus a copy of the env file and systemd unit into `/root/kraki-backups/pre-<version>-<timestamp>/`.
2. Verifies the snapshot with `PRAGMA integrity_check`.
3. `npm install -g @kraki/head@<version>` and checks `kraki-relay --version` matches.
4. `systemctl restart kraki-relay`, waits for the service to become active, and hits `http://127.0.0.1:4000/` to confirm the new version is serving.
5. On any failure between install and post-restart health check, automatically reinstalls the previous version, restores the env file and unit from the snapshot, and reloads systemd.

The snapshot path is printed on both success and failure so you always have a manual rollback target. Old snapshots are pruned after 30 days.

Run on the host:

```bash
sudo /usr/local/sbin/deploy-edge-relay.sh 0.12.0
```

(or invoke `scripts/deploy-edge-relay.sh` directly from a checkout — the script doesn't depend on the repo).

The script pins `npm install` to `https://registry.npmjs.org` so it doesn't see stale versions from mirrors (e.g. `registry.npmmirror.com`, common on Chinese edge hosts, can lag the upstream registry by hours). Override via `NPM_REGISTRY=...` if you need to install from a different source.

### Daily database backups

`scripts/backup-relay-db.sh` performs a WAL-safe `sqlite3 .backup` of the live DB and prunes copies older than 14 days. Install it once on the relay host:

```bash
sudo install -m 0755 scripts/backup-relay-db.sh /usr/local/sbin/kraki-backup-relay-db.sh

sudo tee /etc/cron.daily/kraki-backup >/dev/null <<'EOF'
#!/bin/sh
/usr/local/sbin/kraki-backup-relay-db.sh
EOF
sudo chmod +x /etc/cron.daily/kraki-backup
```

Backups land in `/root/kraki-backups/kraki-relay-YYYYMMDD.db`. Each one is integrity-checked before promotion; corrupt copies are discarded rather than retained.

### Capping journald

If you're seeing the relay's journal grow without bound, cap it system-wide:

```ini
# /etc/systemd/journald.conf
SystemMaxUse=200M
SystemMaxFileSize=50M
MaxRetentionSec=2week
```

Then `sudo systemctl restart systemd-journald`. This only affects log writes and does not disturb the relay process.
