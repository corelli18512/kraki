# Product / experience insights (observation rollout)

Independent Python 3.11+ standard-library job, every minute. It reads the local
Head database **read-only**, reads the existing verified diagnostics spool, and
writes only `/var/lib/kraki-insights`. No relay migration/restart, new public HTTP
endpoint, external analytics provider, or client update is performed by this job.

## Product definitions

The 09:00 Asia/Shanghai digest uses **yesterday's Beijing calendar day**, not the
last 24 hours. Registration total is the current retained account count at report
time (not lifetime including deleted users). New registrations use the central
Tokyo account DB's `users.created_at`; **never sum edge mirrors**, and never use
the edge's mirror-creation timestamp. Open-auth development accounts are excluded;
GitHub accounts are not automatically identified as staff/test accounts.

DAU is one authenticated **account/day**, across devices and regions. Updated
clients send an unqueued raw `ping` with `foreground:true` once per minute while
foreground and authenticated. Web additionally requires a focused visible tab.
Background app/agent connections, old `last_seen`, and optional diagnostic samples
are not DAU. Head uses its own UTC+8 date, ignores a client-supplied user/date, and
accepts this only from app-role sockets. Legacy servers harmlessly answer pong.

Schema 14 adds `daily_active_users` and recording-start metadata. Rows are unique
by day/account, retained for 35 calendar days (today + 34 previous days), cleaned
at the health tick even when idle, and cascade on account deletion. This change
**requires a separately approved relay upgrade**. Full reporting also requires
updated clients: count is always labeled **observed active users within new-client
coverage**, not a magically complete DAU during rollout. Missing tables, stale or
absent peer, mismatched HMAC keys, or a partial first day are explicit unknowns /
incomplete coverage, never an invented zero.

Both hosts use the same root-only >=32-byte random HMAC key. Only daily HMAC'd
account sets travel between the hosts over a dedicated restricted SSH key. Tokyo
unions the sets and emits global counts; China reports regional experience only.
No names, emails, IPs, conversation content, or per-account ids enter the digest.
The HMAC key id (a hash prefix, not the key) prevents mixing incompatible keys.
Rotate both together; historical local account/day rows are re-hashed on export.

## Experience definitions

- Per-region **event-time** 15-minute rolling windows, not upload time or lifetime
  relay histograms. Dedup `(owner, processId, seq)` even across retried batch IDs.
  Delayed uploads fill their historical day; events older than 14 days are dropped.
  Implausible future clocks are excluded. A late upload never creates a current
  slow-operation incident. Regional cohorts are **not** averaged together.
- Group by platform, exact version/build and workflow: send type; cold/warm/wake
  and available network path; voice correction on/off/unknown. Test-platform
  batches are excluded. Old diagnostic builds on normal ios/mac platforms cannot
  be reliably distinguished from production without a new client field.
- Exact nearest-rank P50/P95/P99 over successful, finite durations. Failures,
  timeouts, cancellations, incomplete summaries, sample count, latest event,
  device count and excluded samples remain separately visible. No samples means
  **unknown**, not 0 ms or 100% success. Optional/foreground-delayed diagnostics
  are biased coverage; Web/Windows performance is not yet instrumented.
- Initial P95 candidates: send echo 5s (exclude records flagged offline/background/restored),
  voice release→result 4s, warm foreground current content 3s, cold/wake 5s,
  session current content 1.5s, foreground outage 8s. Agent reply first-text time
  is reported only, **never judged against a relay/network latency target**.
- P95 needs >=20 successful samples, an event within 5 minutes, and 3 consecutive
  minute checks. Recovery needs 3 sufficient checks at <=80% of the target.
  A stale job (>3m), incomplete scan, disabled collector, or too few samples pauses
  judgment: it cannot manufacture a recovery. Overlapping windows are sustained
  observations of the same data, not three independent statistical experiments.
  Existing `send.summary.background` means a failure was shown in the background;
  it is not a full foreground/background timeline. Unmarked background intervals
  cannot always be excluded. Treat these candidates as observations to calibrate,
  not a validated foreground-only service guarantee.
- Failure/timeout candidate: >=20 outcomes, >=3 failures, >1% (voice >2%). Send
  displayed problems >1%; reply text-stall incidence >2% among replies with >=2
  deltas, >=3 affected replies and >=20 observed replies. Recover after 3 sufficient
  checks below threshold. Permission denial, quota exhaustion and identity change
  are excluded from voice service-failure judging; hardware/session/network errors
  remain. Cancellations are separate, not service failures.
- Low-volume candidate: >=3 durations >max(15s, 3×target), sustained 3 checks.
  Raw input/outbox/echo lifecycle also exposes unresolved sends; silence alone is
  **not proof of failure**. >=3 unconfirmed inputs with explicit failed UI state
  is info-only, never notified (offline/upload gaps cannot be excluded reliably).
- Summary-less or dropped client events cannot be reconstructed completely.
  Raw lifecycle is an additional diagnostic hint, not a complete failure denominator.

`experienceNotify:false` keeps all new checks shadow-only **even if existing
infrastructure alerts are enabled**. With explicit approval, setting it true
permits only warning-level experience notifications, not critical rings. Default
installation does not enable it. All proposed limits require real traffic review.

## Installation and peer access

1. Provision `/etc/kraki/insights-hmac.key` on both machines, identical random
   bytes, root:root 0600. Do not commit/copy secrets into reports.
2. `sudo sh ops/insights/install.sh tokyo` / `cn`. Existing config is preserved.
3. For Tokyo's pull from China, create a **separate** SSH key, pin the destination
   host key verified over the existing trusted operator connection, and authorize
   only `export`:

   ```text
   from="<Tokyo fixed IP>",restrict,command="/opt/kraki-insights/export" ssh-ed25519 <public key>
   ```

   No shell, agent/port/X11 forwarding or PTY. Do not reuse backup/admin keys.
   Add to Tokyo's root-private `/etc/kraki/insights.json`:

   ```json
   {"peer":{"host":"cn","destination":"root@cn.relay.kraki.chat","keyFile":"/etc/kraki/insights-peer","knownHostsFile":"/etc/kraki/insights-known-hosts"}}
   ```

   Merge this property into the existing host/db/key-path config; do not replace
   the whole file with this fragment. Root login remains constrained to the forced
   command for this one key. The current topology's source of truth is Tokyo;
   verify the relay mode before marking any other DB `primary:true`.
4. Update watch files/config (without touching Bark keys). Host config reads
   `/var/lib/kraki-insights/summary.json`, defaults `experienceNotify:false`.
   `KRAKI_WATCH_NOTIFY=0` keeps automatic alerts off. **Only with approval**, set
   `KRAKI_WATCH_DIGEST_NOTIFY=1` to enable the passive 09:00 digest independently.
5. Check both jobs/timers, private file permissions, peer failure/key mismatch,
   and both relay PIDs unchanged. No production outage injection is needed.
   First deployment is not full DAU coverage until relay/client upgrades ship.

Files: `export.json` contains the local HMAC sets (root-only, three days);
`summary.json` contains only global counts/regional distributions for watch.
`index.sqlite` holds selected metadata for 14 days. Old files/index rows are pruned;
SQLite page/WAL reclamation is logical retention, not forensic secure erasure.
Service CPU/memory/time limits bound failure impact; stale output is explicit.

APNs payloads are bounded: the digest prioritizes user counts and worst experience
cohorts, then infrastructure. Long pushes may be shortened. Full distributions
remain in `summary.json`; full latest digest text in
`/var/lib/kraki-watch/digest-latest.json`. Do not expose either as public endpoints.

Rollback: disable only `kraki-insights.timer`, restore the previous watch release /
config, leave the account DB untouched. Schema 14's additive tables can remain on
an older relay; do not drop them as part of operational rollback. Keep both key
files and private exports protected until a deliberate retention cleanup.

Tests: `python3 -B -m unittest discover -s ops/insights -p 'test_*.py'`;
`node --test ops/watch/test/*.test.mjs` also runs these in the existing CI lane.
Before client release, publish the separate foreground usage disclosure in
`docs/privacy-performance-data.md` and update the relevant App Store labels.
