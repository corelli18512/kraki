# kraki-watch

All generated operational notifications and host/cohort labels are English-only.
When updating a previously deployed non-English configuration, preserve thresholds,
probe identities, counters and notification permissions; migrate cached display
labels and probe-name keys with a private backup. Do not reset alert history to
change its language. Retain Unicode payload tests for external diagnostic text.

Product statistics and event-time client experience observation are provided by
[`ops/insights`](../insights/README.md). Host configs read its private summary;
`experienceNotify:false` keeps new experience rules silent independently of
infrastructure rules. `KRAKI_WATCH_DIGEST_NOTIFY=1` can enable only the passive
09:00 digest while `KRAKI_WATCH_NOTIFY=0` keeps alerts shadowed; both remain off
until explicit operator approval. Full digest text is retained in
`/var/lib/kraki-watch/digest-latest.json`; large phone payloads are shortened.
: relay alerting

Alerts for the two production relays (Tokyo `relay.kraki.chat`, China
`cn.relay.kraki.chat`) and the services around them, delivered to a phone with
[Bark](https://github.com/Finb/Bark). Free services only.

```
External uptime checks ───────────────> independent email
healthchecks.io (missing heartbeat) ──> independent email (+ Bark if supported)
Tokyo: kraki-watch ── probes China ──┐
                                    ├──> Bark ──> iPhone
China: kraki-watch ── probes Tokyo ──┘
```

## Levels

| Level | When | On the phone | Repeats | 23:00–08:00 (Beijing) |
|---|---|---|---|---|
| Critical | users are or soon will be affected | requests Critical Alerts (`level=critical`, `call=1`, ~30 s); requires phone permission and an on-device test | every 30 min until it recovers, then one "recovered" | requested even at night |
| Warning | something is wrong, users not yet affected | time-sensitive notification | at most every 6 h | held, sent as one batch at 08:00 |
| Info | worth knowing | not pushed | — | — |

A daily summary is scheduled at 09:00 even when everything is fine. **No summary
by 09:30 is a reason to check the monitoring/delivery chain**, not proof of a
specific failure. The first run on a host only starts the day; the first summary
comes the next morning. API acceptance is not proof that the phone displayed or
sounded a notification.

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
| `K-BARK-DOWN@host` | critical | local private Bark `/bark/ping` fails 3 in a row (Bark unit is also monitored) |
| `K-BARK-PEER@host` | critical | other host's public Bark ping fails 5 in a row; deliver through this host's own Bark |
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
  lib/bark.mjs         Bark delivery (JSON POST, response validation, bounded retries)
  lib/config.mjs       secret-safe delivery configuration validation
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

1. **Bark**: install Bark on the iPhone and allow notifications including
   *Critical Alerts*. Our two-host deployment uses [private Bark servers](../bark/README.md),
   with one key per host and local delivery (`BARK_SERVER=http://127.0.0.1:4080/bark`).
   The official `https://api.day.app` remains a supported alternative for other
   deployments. Copy just the key from the selected server's sample URL.
   Treat both this key and
   heartbeat URLs as secrets: no repository, screenshots, issue bodies or shell
   command arguments. Store them in the root-only env file below.
2. **Independent detection and delivery**: configure one healthchecks.io check
   per host (period 1 min, grace 15 min), with an email recipient independent of
   Bark. Use an external uptime service for `https://relay.kraki.chat/`,
   `https://cn.relay.kraki.chat/`, and `https://app.kraki.chat/`; use the
   `"status":"ok"` keyword for relays if supported. Verify the chosen account's
   current free limits, interval, keyword and email features when setting it up.
   Do **not** assume UptimeRobot includes free webhooks. A Bark integration is
   optional and must not replace the independent email route. Verify both
   outage and recovery email delivery with a dedicated test check.
3. **Stage configuration before installing**, on each host as root:
   ```sh
   install -d -m 755 /etc/kraki
   # Only for a first install; do not overwrite an existing secrets file.
   test -f /etc/kraki/watch.env || install -m 600 ops/watch/watch.env.example /etc/kraki/watch.env
   ```
   Fill `/etc/kraki/watch.env` using an editor: `BARK_KEY`, `HC_PING_URL`, and
   backup settings if enabling backups (`KRAKI_DB`: Tokyo
   `/home/ubuntu/kraki-head.db`, China `/var/lib/kraki/kraki-relay.db`). Keep
   `KRAKI_WATCH_NOTIFY=0` initially. Set up restricted off-site-copy access and
   verify a backup/restore to a temporary database before enabling backup timers.
4. **Install only after deployment approval** (copy `ops/watch` and
   `scripts/backup-relay-db.sh` from the same revision):
   ```sh
   sh ops/watch/install.sh tokyo   # Tokyo; use cn on the China host
   kraki-watch check-config
   ```
   `check-config` is offline: checks delivery settings and JSON readability;
   it neither sends notifications/heartbeats nor changes alert state. It is not
   a full host or phone readiness check. Installation does **not** restart the
   relay, but **does** start the watch timer. Journald is untouched unless
   `--with-journal-policy` is explicitly passed (that option changes retention
   and restarts journald). Add `--with-backup` only after backup configuration and
   restore verification. Relay readiness/metrics also require a separately
   authorized Head release; merging their code does not deploy them.
5. **Shadow mode** for two days: `journalctl -u kraki-watch | grep shadow`
   shows what would have been sent. Tune noisy thresholds before enabling.
6. **Enable and verify with the operator present**: set `KRAKI_WATCH_NOTIFY=1`,
   run `kraki-watch check-config`, then `kraki-watch test-notify` (one critical,
   one warning) and `kraki-watch digest-now`. `test-notify` refuses shadow mode
   and exits nonzero if Bark rejects either message. Confirm receipt on the
   actual phone, then test critical sound while locked and in silent/Focus
   modes. Do not perform a ringing test at night without agreement.
7. **Safe drill first**: use a separate test config/state directory with an
   intentionally unreachable local test endpoint, then restore that endpoint
   and verify recovery. Exercise external heartbeat failure using a dedicated
   test check. Do not stop production proxies, relays or watch timers for a
   drill without separate, explicit outage approval.

## Operating

- **Deploys**: `kraki-watch maintenance 10` silences this host's own checks for
  10 minutes (`scripts/deploy-edge-relay.sh` does it automatically). The other
  host and UptimeRobot still watch.
- **State**: `/var/lib/kraki-watch/state.json`. Deleting it resets all alerts.
- **Bark unreachable or rejecting messages**: undelivered messages are kept
  (up to 20) and retried on the next run, marked "[Delayed]". Delivery requires
  both HTTP success and Bark JSON `code: 200`. Redirects are rejected to avoid
  forwarding the key; logs omit upstream response bodies and raw error text.
- **Missing key with notifications enabled**: fails before updating state or
  sending a healthy heartbeat; it is never silently treated as shadow mode.
- **Self-hosting limits**: a private Bark server avoids the author's HTTP
  service, but the official iOS app still depends on Bark's Apple app identity
  and APNs credentials, plus Apple delivery. Do not put the only notification
  route on the same host it monitors; retain independent email.
- **Off-site backups** need a dedicated key: `/root/.ssh/kraki-backup` on each
  host, its public key on the other host restricted to the incoming backup
  directory. Restore: `gunzip` the copy, stop the relay, replace the database,
  start the relay.
