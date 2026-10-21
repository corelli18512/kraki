# Client Stability Metrics (iOS / Mac)

Goal: using metadata only, see every step that affects the user experience in the two native clients: opening the app, outages, sending messages, voice, opening a conversation, and crashes or being killed by the system.

Principles:
- Each "process" reports **one summary** when it ends.
- Only durations, counts and cause category labels are recorded — never message text, error strings or network names.
- The logic lives in `StabilityTracker` / `SendTracker` / `VoiceTracker` (`Core/Diagnostics/`). This code is always compiled, so it is covered by unit tests.
- Production iOS / Mac builds report, through the KrakiDiag → `kraki-diag` Monitor channel (Release compiles `KRAKI_DIAG KRAKI_DIAG_EXISTING_IDENTITY`). The user can turn it off in Settings → Privacy → Share Performance Data (on by default; off deletes anything unsent), and the collector can turn it off for everyone (`touch $KRAKI_DIAG_DIR/DISABLED` → config `enabled:false`). Privacy text: `docs/privacy-performance-data.md`.
- Uploads use any network except Low Data Mode, in the foreground, outside Low Power Mode and thermal pressure. A heavy day (200 messages with replies, full event feed) is about 65 KB in ~11 requests; recording one event costs ~0.3 µs. Both are checked by `scripts/diag/run-native-tests.sh` (budget: < 100 KB/day, < 20 µs/event). Production keeps at most 5 MB unsent; test builds 50 MB.
- Web and Windows do not report yet.

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
  - `backgroundMs`: how long the app was in the background (or asleep), including device sleep (before the 2026-10 audit fix it stopped while the device slept)
  - `path`: wifi / cellular / wired / other / none; the first answer of the path monitor if the opening started before it (cold openings were always `unknown`)
  - `cause`: how the last connection lost during this opening ended (same tags as `outage.summary.source`). A drop before the opening is ready belongs to the opening, not to an outage, so on iOS (which reconnects on every return) this is where drops show up
  - `previousExit`: cold only. `unclean` means the previous process died in the foreground — a crash, a hang killed by the system, or a force quit
  - `kept`: warm only. The signed-in socket survived the background (iOS keeps it about 25 s, see `BackgroundSocketGrace`), so nothing reconnected and every milestone is 0
- **outcome**: `ready`; `abandoned` (left before ready); `timeout` (not ready after 30 s).

### `outage.summary`: foreground outage
Counts only outages while signed in, in the foreground, and not during an "open" process; deliberate background disconnects and sleep do not count.
- `source`: how the client noticed. Values include `peer_closed` (with close code), `transport_error` (with NSError code), `ping_timeout`, `transport_silent`, `receive_failed`, `auth_reply_timeout` (a sent sign-in got no answer within 5 s, doubling to 20 s), etc. The same tags appear in `ws.state.source`.
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

### `reply.summary`: one reply turn this device started
Starts when this device's own message comes back from the agent's computer (the echo, so `send.summary.confirmMs` covers send → echo) while the app is in the foreground; steers stay inside the running turn. Owned by `MessageRouter.replyMetrics` (`MessageRouter+Replies.swift`, `ReplyTracker`).
- `firstActivityMs`: echo → first sign of the reply (tool step, text, message). Mostly the agent's own thinking plus one relay hop.
- `firstTextMs`: echo → first reply text.
- `durationMs`: echo → end of the turn.
- `deltas`, `maxGapMs`, `stalls`: streamed text deltas, the longest gap between consecutive deltas of one text run, and gaps ≥ 3 s. A tool step ends a text run, so a long tool is not a stall. Deltas only reach the conversation that is open, so these are 0 for replies the user was not watching.
- `kind`: typed / answer. `outcome`: `completed` (idle), `failed` (turn_status failed or idle reason failed), `stopped` (stopped / idle reason aborted, interrupted, session ended or deleted), `backgrounded` (iOS left the foreground; timings after that are not the user's experience), `superseded` (a new turn started before this one ended), `abandoned` (end missed: a reconnect found the session idle or gone, no end within an hour, or more than 32 open turns). An empty reset delta and a null card action (what a stop sends) are not reply text or activity.

"Reply feels slow" splits into: `send.summary.confirmMs` (Kraki round trip) + `reply.summary.firstTextMs` (agent + one hop); stalls point at streaming.

### `open.summary`: opening a conversation
Recorded while online, and also while an app-open or outage record is in progress (then `reconnecting: true`: the wait includes signing in again — "reconnected, opened the chat, Syncing…"). Not recorded offline with no reconnect running.
- Fields: `firstContentMs`, `viewCurrentMs`, `gap`, `reconnecting`
- outcome: `current` (caught up), `left` (left midway), `timeout`

### `history.batch`: a catch-up (head) reply arrived
- `durationMs`: the head request left this device → its reply was handled on the main thread. Compare with the Tentacle's `Replied to turn-aware session messages request` log line to split the Tentacle's share from the network / Head / decrypt queue.
- `count`: messages in the reply (with `afterSeq` a reconnect usually gets 1–2, not a whole turn).
- `viewing`: it was the conversation on screen. `attempt`: 0 for the first request, then timeout retries.

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
| Echo → first reply activity `firstActivityMs` | track only (agent-dependent) |
| Replies with a stall ≥ 3 s | < 2% |
| Open conversation → latest on screen | < 1.5 s |

## Viewing the data (manual tool, not in CI)

```bash
python3 scripts/diag/stability-report.py --pull corelli-tecent-cloud-small-0 --out /tmp/stability \
  [--head-log head.log] [--since 2026-10-01] [--platform ios|mac]
```

Produces `/tmp/stability/stability-report.html`, summarized in five sections, with values over target in red. Given a Head log (`journalctl -u kraki-relay`), it also lists server-side reconnect storms (≥3 authentications within 2 minutes), which shows storms even when the clients are not diagnostics builds.

## Release order (important)

Monitor validates against an allowlist. An event or field it does not know is dropped; a known field (or `sid`) with a value outside its format is dropped from its event and logged by name (`diag dropped invalid values … fields=voice.action.sid`), never by value. Only a malformed batch envelope still gets 400, and the client deletes a batch that got a 400. (Until the 2026-10 audit any bad value rejected the whole batch: 9 batches were lost to the new-session voice draft id as `sid`.) New data is still lost until Monitor knows it, so:

1. **Deploy Monitor first** (`packages/monitor`).
2. Then release diagnostics clients that emit these events.

`packages/monitor/src/__tests__/schema-sync.test.ts` parses the Swift sources and checks that event names, fields, enumerated values and the automatic-resend `resend_*` states are all in the allowlist. It caught one gap: the `resend_*` states introduced by #329 were missing, so any batch containing an automatic resend was dropped entirely; fixed in the same PR.
