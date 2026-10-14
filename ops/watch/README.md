# kraki-watch: relay alerting

Alerts for the two production relays (Tokyo `relay.kraki.chat`, China
`cn.relay.kraki.chat`) and the services around them, delivered to a phone with
[Bark](https://github.com/Finb/Bark). Free services only.

```
UptimeRobot (outside view, every 5 min) ──────────────┐
healthchecks.io (no heartbeat for 15 min) ────────────┤
                                                      ├──> Bark ──> iPhone
Tokyo: kraki-watch (every minute) ── probes China ────┤
China: kraki-watch (every minute) ── probes Tokyo ────┘
```

## Levels

| Level | When | On the phone | Repeats | 23:00–08:00 (Beijing) |
|---|---|---|---|---|
| Critical | users are or soon will be affected | rings through silent mode and Focus (`level=critical`, rings ~30 s) | every 30 min until it recovers, then one "recovered" | rings |
| Warning | something is wrong, users not yet affected | time-sensitive notification | at most every 6 h | held, sent as one batch at 08:00 |
| Info | worth knowing | not pushed | — | — |

A daily summary arrives at 09:00 even when everything is fine. **No summary by
09:30 means the alerting itself is broken.** The first run on a host only starts
the day; the first summary comes the next morning.

Messages carry the host, the problem and a number, never user data.

## Checks

The thresholds are first guesses; tune them after the shadow period.

| ID | Level | Fires when |
|---|---|---|
| `K-RELAY-DOWN@host` | critical | `https://…relay…/` not `200 {"status":"ok"}` 3 runs in a row (10 s timeout) |
| `K-RELAY-WS@host` | critical | WebSocket handshake not `101`, 3 in a row |
| `K-RELAY-READY@host` | critical | `/health/ready` not ready (database, event loop, push providers), 3 in a row. A relay older than the endpoint is skipped |
| `K-PEER-DOWN@host` | critical | the *other* relay, probed from this one, fails 5 in a row (15 s timeout) |
| `K-WEB-DOWN@web` | critical | `app.kraki.chat` fails 3 in a row (Tokyo) |
| `K-SITE-DOWN@site/dl-mac/dl-win` | warning | `kraki.chat` down, or `/download/mac` / `/download/windows` no longer redirect to a release asset, 5 in a row |
| `K-VOICE-DOWN@…` | critical | voice gateway `/healthz` fails (China: 3 in a row; Tokyo checks `stt.kraki.chat`, 5 in a row), or its unit stops |
| `K-SLOW@host` | warning | median of the last 10 relay probes > 2 s |
| `K-SVC-FAILED@unit` | per unit | unit `failed` (at once; the unit's `OnFailure=` also starts a run immediately) or otherwise not active for 2 runs |
| `K-SVC-RESTART@unit` | warning (once) | the unit restarted outside a deploy (with the relay's last crash message) |
| `K-SVC-FLAP@unit` | critical | 3+ restarts within an hour |
| `K-DIAG-DOWN` | warning | diagnostics collector stopped / `/health` fails 5 in a row |
| `K-DISK` | warning → critical | root filesystem ≥ 85% / ≥ 95% |
| `K-MEM-HOST` | warning | host available memory < 10% for 10 runs |
| `K-MEM` | warning | relay RSS > 512 MB for 10 runs |
| `K-HEALTH-SILENT` | critical | relay unit active but no `health` log line for 3 min (stuck event loop) |
| `K-DURABLE` | warning | `durableRows` > 1000 and higher than 30 min ago |
| `K-CONN-DROP` | warning | connections fell by > 70% within 5 min (from ≥ 3) |
| `K-PUSH-FAIL` | warning | ≥ 10 push failures in 10 min and > 20% of attempts |
| `K-PUSH-AUTH` | critical | ≥ 3 APNs credential errors (`InvalidProviderToken`, `ExpiredProviderToken`, 403…) in 10 min |
| `K-AUTH-FAIL` | warning | ≥ 10 GitHub sign-in / device registration failures in 10 min |
| `K-AUTH-ABUSE` | info | ≥ 100 rejected / throttled auth attempts in 10 min |
| `K-STALL` | warning | ≥ 5 connections closed for a full send buffer in 10 min |
| `K-PULSE` | critical | any `pulse-hub` snapshot / GC failure in 10 min (possible message loss) |
| `K-REGION` | warning | ≥ 3 edge/account-service sync failures in 10 min |
| `K-VOICE-ERR` | warning | any `Voice lease persist failed` in 10 min |
| `K-ERRORS` | warning | ≥ 20 other error lines in 10 min (names the top 3) |
| `K-CERT@domain` | warning → critical | certificate expires in < 14 / < 3 days (checked hourly) |
| `K-BACKUP` | critical | no successful database backup within 26 h |
| `K-BACKUP-COPY` | critical | the latest backup failed to reach the other relay |
| `K-BACKUP-SIZE` | warning | the new backup is less than half the previous one |
| `K-VERSION` | info | the two relays run different versions |
| heartbeat (healthchecks.io) | critical | no run reported for 15 min: host down, network down, or kraki-watch broken |

Log checks read the relay's journal since the previous run. Relay numbers come
from the relay's loopback-only `/internal/metrics` when available (see
`packages/head/README.md`), otherwise from the log.

## Files

```
ops/watch/
  kraki-watch.mjs      entry point (no dependencies, Node ≥ 20)
  lib/engine.mjs       alert state: failAfter, repeats, recovery, quiet hours, summary timing
  lib/rules.mjs        snapshot → check results
  lib/logs.mjs         relay log parsing
  lib/digest.mjs       daily summary text
  lib/bark.mjs         Bark delivery
  lib/collect.mjs      probes, systemd, journald, disk, memory, certificates
  config/tokyo.json    what each host checks
  config/cn.json
  systemd/             kraki-watch.{service,timer}, kraki-backup.{service,timer},
                       OnFailure drop-in, journald retention (30 days / 1 GB)
  install.sh           installs on a host (idempotent)
  watch.env.example    secrets template → /etc/kraki/watch.env (mode 600)
scripts/backup-relay-db.sh   daily WAL-safe backup, integrity check, optional off-site copy, status for K-BACKUP
```

Tests: `node --test ops/watch/test/*.test.mjs` (run in CI's scope job). The
end-to-end test runs the real script against a fake relay, fake Bark and fake
`systemctl` / `journalctl`.

## Setup

1. **Bark**: install Bark on the iPhone, allow notifications including
   *Critical Alerts*, copy the key from the URL it shows
   (`https://api.day.app/<KEY>/…`).
2. **healthchecks.io** (free): one check per host, period 1 min, grace 15 min,
   integration "Bark" or webhook `https://api.day.app/<KEY>/<title>?level=critical`.
   Copy each ping URL.
3. **UptimeRobot** (free): HTTP(S) keyword monitors every 5 min on
   `https://relay.kraki.chat/` and `https://cn.relay.kraki.chat/` (keyword
   `"status":"ok"`) and `https://app.kraki.chat/`; alert contact: webhook to Bark.
4. **Install on each host** as root (copy `ops/watch` and `scripts/backup-relay-db.sh`
   from the same checkout):
   ```sh
   sh ops/watch/install.sh tokyo --with-backup   # on corelli-aws-tokyo-0
   sh ops/watch/install.sh cn --with-backup      # on corelli-tecent-cloud-small-0
   ```
   Then fill `/etc/kraki/watch.env`: `BARK_KEY`, `HC_PING_URL`, and the backup
   settings (`KRAKI_DB`: Tokyo `/home/ubuntu/kraki-head.db`, China
   `/var/lib/kraki/kraki-relay.db`; `KRAKI_BACKUP_REMOTE` to the other host).
5. **Shadow mode** (the default, `KRAKI_WATCH_NOTIFY=0`) for two days:
   `journalctl -u kraki-watch | grep shadow` shows what would have been sent.
6. **Enable**: `KRAKI_WATCH_NOTIFY=1`, then `kraki-watch test-notify` (one
   critical, one warning) and `kraki-watch digest-now`.
7. **Drill**: stop the reverse proxy on one host for 4 minutes → a critical
   within 3 minutes, recovery after restart; stop `kraki-watch.timer` → the
   heartbeat alert within 15 minutes.

## Operating

- **Deploys**: `kraki-watch maintenance 10` silences this host's own checks for
  10 minutes (`scripts/deploy-edge-relay.sh` does it automatically). The other
  host and UptimeRobot still watch.
- **State**: `/var/lib/kraki-watch/state.json`. Deleting it resets all alerts.
- **Bark unreachable**: undelivered messages are kept (up to 20) and retried on
  the next run, marked "[延迟送达]".
- **Off-site backups** need a dedicated key: `/root/.ssh/kraki-backup` on each
  host, its public key on the other host restricted to the incoming backup
  directory. Restore: `gunzip` the copy, stop the relay, replace the database,
  start the relay.
