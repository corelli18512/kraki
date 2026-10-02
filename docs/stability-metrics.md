# Client Stability Metrics (iOS / Mac)

Goal: using metadata only, see every step that affects the user experience in the two native clients: opening the app, outages, sending messages, voice, opening a conversation, and crashes or being killed by the system.

Principles:
- Each "process" reports **one summary** when it ends.
- Only durations, counts and cause category labels are recorded — never message text, error strings or network names.
- The logic lives in `StabilityTracker` / `SendTracker` / `VoiceTracker` (`Core/Diagnostics/`). This code is always compiled, so it is covered by unit tests.
- Only diagnostics builds (`KRAKI_DIAG`) report, through the existing KrakiDiag → `kraki-diag` Monitor channel. Production builds report nothing and do not start the network path monitor.

## Events

### `ready.summary`: app opened → latest messages on screen
- **kind**: `cold` is the process's first connection; `warm` is iOS returning from the background; `wake` is the Mac waking from sleep.
- **Milestones**: milliseconds from the moment the app became visible.
  - `firstContentMs`: content on screen, possibly stale
  - `wsOpenMs`: connection open
  - `authedMs`: authenticated
  - `listFreshMs`: session list updated
  - `viewCurrentMs`: the current conversation has caught up; on the session list, the list is up to date
- **Other fields**:
  - `attempt`: number of failed retries
  - `gap`: how many messages the current conversation was missing on open
  - `backgroundMs`: how long the app was in the background (or asleep)
  - `path`: wifi / cellular / wired / other / none
  - `previousExit`: cold only. `unclean` means the previous process died in the foreground — a crash, a hang killed by the system, or a force quit
- **outcome**: `ready`; `abandoned` (left before ready); `timeout` (not ready after 30 s).

### `outage.summary`: foreground outage
Counts only outages while signed in, in the foreground, and not during an "open" process; deliberate background disconnects and sleep do not count.
- `source`: how the client noticed. Values include `peer_closed` (with close code), `transport_error` (with NSError code), `ping_timeout`, `transport_silent`, `receive_failed`, etc.
- Durations:
  - `detectMs`: last data received → outage detected (long for half-open connections)
  - `reconnectMs`: detected → re-authenticated
  - `catchupMs`: authenticated → caught up
  - `impactMs`: last data received → caught up, i.e. how long the user was actually affected
  - `visibleMs`: how long "Reconnecting" was actually shown
- Context:
  - `attempt`: number of retries
  - `pathChanged`: the network changed within 10 s before the outage
  - `afterWake`: within 60 s after waking
  - `path`: current network type
- outcome: `recovered`; `backgrounded` (left during the outage); `abandoned` (not recovered after 10 minutes).

### `send.summary`: one message from send to end
- `kind`: typed / voice / answer / steer
- `outcome`: `delivered` (echo confirmed); `deleted` (deleted by the user); `cleared` (signed out or conversation deleted)
- `confirmMs`: creation → confirmation, measured from the original send time even across restarts
- `correctionMs`: correction time for voice messages
- `shown`: the worst state ever shown, none / unconfirmed / failed; `shownMs`: total time it was shown
- `cause`: `stalled` (no echo), `correction` (voice correction failed), `signed_out`, `refused`
- `background`: whether the app was in the background when the message was marked failed
- `manualRetries` / `autoResends`: number of manual retries and automatic resends
- `restored`: whether it spanned an app restart
- `offline`: whether the link was down when sending
- `falseAlarm`: derived by the client — a problem was shown, but the message was delivered without a manual retry

### `voice.summary`: one recording
- `outcome`:
  - `final`: got a result
  - `failed`
  - `cancelled`
  - `departed`: left the conversation
  - `suspended`: the app went to the background
  - `ended`: other endings, e.g. quota ran out while finishing and only the raw draft was kept
- `stage`: stage at the end, preflight / permission / lease / recording / finishing
- `cause`: failure category
  - Permission and device: `permission`, `mic_unavailable`, `audio_session`
  - Service and network: `unavailable`, `offline`, `timeout`, `network`, `gateway`
  - Quota and lease: `quota`, `lease_timeout`, `lease_busy`, `lease_rejected`, `lease_denied_<reason>`
  - Other: `identity_changed`, `config`
- Durations:
  - `startMs`: press → capture started, including permission, lease and connection waits
  - `recordMs`: recording length
  - `finalizeMs`: release → result
- Other:
  - `confirmed`: whether correction was confirmed; when unconfirmed, the raw draft is kept
  - `warm`: whether the connection was pre-warmed at press time
  - `count`: number of lease rollovers
  - `correctionOn`: whether Correct Transcripts was on for this recording. When off, `confirmed=false` is expected and not a correction failure

### `open.summary`: opening a conversation
Recorded only while online and not during an app-open or outage process.
- Fields: `firstContentMs`, `viewCurrentMs`, `gap`
- outcome: `current` (caught up), `left` (left midway), `timeout`

## Proposed targets (first draft; finalize after a week of data)

| Metric | p95 target |
|---|---|
| warm → latest on screen | < 3 s |
| cold / wake → latest on screen | < 5 s |
| Outage impact `impactMs` | < 8 s |
| Foreground outages | < 1 per day; ≥3 within 2 minutes is a storm and should be 0 |
| Send confirmation `confirmMs` | < 5 s |
| Messages shown as a problem | < 1%, false alarms should be 0 |
| Voice release → result | < 4 s |
| Voice failure rate | < 2% |
| Open conversation → latest on screen | < 1.5 s |

## Viewing the data (manual tool, not in CI)

```bash
python3 scripts/diag/stability-report.py --pull corelli-tecent-cloud-small-0 --out /tmp/stability \
  [--head-log head.log] [--since 2026-10-01] [--platform ios|mac]
```

Produces `/tmp/stability/stability-report.html`, summarized in five sections, with values over target in red. Given a Head log (`journalctl -u kraki-relay`), it also lists server-side reconnect storms (≥3 authentications within 2 minutes), which shows storms even when the clients are not diagnostics builds.

## Release order (important)

Monitor validates against an allowlist: if a batch contains any event, field or value it does not know, it rejects the **whole batch** with 400, and the client deletes a batch that got a 400. Therefore:

1. **Deploy Monitor first** (`packages/monitor`).
2. Then release diagnostics clients that emit these events.

`packages/monitor/src/__tests__/schema-sync.test.ts` parses the Swift sources and checks that event names, fields, enumerated values and the automatic-resend `resend_*` states are all in the allowlist. It caught one gap: the `resend_*` states introduced by #329 were missing, so any batch containing an automatic resend was dropped entirely; fixed in the same PR.
