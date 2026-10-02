# Kraki Diag — Client Diagnostics Design and Implementation Handoff

Updated: 2026-09-27. Additional authorization from the user: **ship the client release and get the cloud REST endpoint actually running, without installing/updating anything for the user**.
Release worktree: `kraki-client-diagnostics-release`, based on the latest main, keeping existing client logins/data.

## Current code ownership: standalone `@kraki/monitor`

The diagnostics REST collector now lives in [`packages/monitor`](../packages/monitor/README.md) and is no longer part of the Head package.
It builds, starts, tests and deploys independently, with zero runtime npm dependencies; it only queries registered device public keys through a read-only SQLite adapter to verify signatures.
Head no longer embeds the collector; diagnostics paths sent to Head return 404. The public `/api/diag/v1/*` paths, the signature protocol,
the `kraki-diag` service name, loopback:4011, environment variables and log storage paths are all unchanged.
The deploy entry point is `packages/monitor/scripts/deploy.sh`; the old `scripts/diag/deploy-sidecar.sh` only forwards for compatibility.
This refactor was changed and verified locally only — **no deploy, no Head/collector restart, no user app update**.
The phase-one progress/performance numbers below are a historical snapshot; they do not imply a re-authorized deploy or the latest upload scheduling parameters.

## Release addendum (historical release record; takes precedence over the original phased plan below)

- This release uses an explicit `DiagnosticsDelivery` configuration: Release optimization + `KRAKI_DIAG KRAKI_DIAG_EXISTING_IDENTITY`.
  It keeps the production bundle/keychain/defaults/outbox identity and ships through the existing TestFlight / Sparkle channels;
  a normal Release still contains no log collection code, and the Diagnostics configuration with its separate `.diag` identity is kept.
- iOS enables it only via workflow_dispatch `diagnostics=true`; Mac only via an explicit `mac-v…-diag` tag.
  `verify-diagnostic-delivery.sh` verifies logging/toggle/existing identity; normal releases still use `verify-no-diag.sh`.
- Target versions this round: iOS 0.1.8 (build number assigned by the TestFlight workflow), Mac 0.2.40 (42).
- Settings has a "Record and Send Diagnostics" toggle (on by default in diagnostics builds), the last upload time, the pending amount and a manual problem-marker button.
- Added `ui.busy` (busy intervals ≥50 ms completed by the foreground run loop, excluding sleeping; not a watchdog stack),
  `list.snapshot` (counts/seq bounds/pending changes), `session.view`, and cross-platform `voice.action` metadata.
- REST is deployed as a **standalone service** (current entry point `packages/monitor/src/cli.ts`), with a read-only Node 24 built-in SQLite connection to Head's devices table;
  `/api/diag/v1/*` on the existing domain is reverse-proxied to loopback:4011, without upgrading/restarting Head/Pulse.
- The heavy black box, automatic rendering anomaly detection and full on-device A/B testing continue to iterate and are no longer prerequisites for this interim release;
  we still do not claim whole-device CPU/network latency percentages. Release and production verification results are kept in a separate release verification document.
- Operating permissions do not include launching/installing/replacing the app the user is using; the user updates it themselves later.


## 1. Purpose and evidence boundaries

- Find where the second, new `clientId` of a duplicated answer is generated, instead of hiding the problem behind a gate.
- Locate iOS/macOS stutters, message-processing latency and bubble rendering problems.
- Do not change the business semantics of buttons, message delivery, stale answerTo, the outbox or Pulse.

In the field we confirmed two persisted messages with identical text and different clientIds; a normal resend reuses the ID, so it cannot explain this.
But there is still no direct evidence of the second call's origin, the original answerTo, or which device/installed build had the problem.
**Do not present "the callback is necessarily called twice" or "a busy Mac caused a double click" as a proven root cause.**

The existing `KLog.diag/chat/chatEntry` include release-safe logs, so production builds are not entirely without logs;
the real gaps are structured correlation, durable collection, remote collection and performance observation of common paths.

## 2. Corrections to the early draft (this document supersedes the old plan)

1. Head's AccountApi Bearer is a **service-to-service secret**, not an app access token. Never give it to clients.
2. No `simultaneousGesture` / private `_onButtonGesture`: diagnostics must not change the click dispatch under investigation.
3. No unverified lock-free MPSC, suspending the main thread from the background to capture stacks, or an always-on full-rate DisplayLink.
4. Do not upload SHA1/short hashes of message text: multiple-choice/short text can be reversed with a dictionary. Record only byte counts and existing correlation IDs.
5. REST avoids Pulse application-level queuing/replay, but **cannot guarantee zero contention with the WebSocket on the physical link**.
6. Earlier estimates such as <0.5% CPU and <20 MB per day were not measurements; 20 MB is now a hard limit, not a prediction.
7. `ix` is passed explicitly along synchronous calls only; "the most recent user action within 500 ms" must not pose as the causal source of a layout.
8. Normal iOS version numbers keep a valid numeric format; builds are told apart by bundle ID, display name and the Dev icon, not a `-diag` version suffix.
9. No background URLSession for now: the first version uses foreground low-priority transfers and resumes on the next launch after suspension; no promise of immediate arrival after exit.
10. Do not upload MetricKit payloads verbatim (they may contain paths etc.); later, extract only reviewed fields.

## 3. Phase-one implementation status

### Implemented paths

- `packages/arm/ios/Kraki/Core/Diagnostics/DiagRecorder.swift`
  - 1024-entry bounded queue, `NSLock.try()`; drops on contention, never waits on the UI.
  - Per-process sequence numbers and monotonic time; at most 200 events per second.
  - A worker does JSON/gzip/file IO; each file ≤16 KiB compressed, ≤48 KiB uncompressed.
  - Atomic complete batch files, at most 50 MiB / 2048 files, oldest evicted first; excluded from backups, private permissions.
- `.../Diagnostics/KrakiDiag.swift`
  - Utility queue, flush to disk every 15 seconds; key events such as answers/receipts/outbox are coalesced and written locally after about 250 ms, without triggering an immediate upload.
  - At most one pending key-event flush at any time; one dedicated HTTP task. A force kill/power loss can still lose the last unwritten events; zero loss is not promised.
  - After a normal success, wait at least 60 seconds before uploading again; delay 10 seconds after answer activity; failures back off exponentially up to 1 hour with jitter.
  - No transfers on cellular/expensive/constrained networks; pause in Low Power Mode or at serious/critical thermal state.
  - At most 20 MiB of compressed HTTP request bodies attempted per UTC day, with the count persisted across restarts; failed attempts count too.
  - Turning the local switch off cancels the task and discards in-memory and unsent files. Bytes already on the network cannot be recalled.
  - Switching device/relay clears the old realm; batches from one signed-in identity are never sent as another.
- `packages/monitor/src/diag-api.ts`
  - Independent signature authentication, schema allowlist, size/rate/quota/concurrency limits, idempotent file storage, 14-day retention.
  - Without `KRAKI_DIAG_DIR` it returns 410 and does not touch the diagnostics directory.
- Build configuration, settings toggle, release binary guard.
- Input chain, outbox, receipts, lifecycle, Mac click source and basic slow-path timing.
- Offline viewer `scripts/diag/timeline.py`.

### Explicitly not done yet

Full rendering state change/anomaly detection, frame and run loop monitoring, the black-box window, the full voice/attachment/Steps/push chain,
a complete diagnostics health UI, on-device A/B, battery/memory testing, production service deployment and signed distribution.
**Do not describe phase one as the complete plan delivered or ready to distribute.**

## 4. Build isolation and identity

`packages/arm/ios/project.yml`:

| Configuration | Type/condition | Identity |
|---|---|---|
| Debug | the existing debug, without KRAKI_DIAG | existing Dev identity |
| Release | the existing release, without KRAKI_DIAG | existing production identity |
| Diagnostics | release optimization; only this configuration defines KRAKI_DIAG | iOS `chat.kraki.ios.diag`; Mac `chat.kraki.mac.diag` |

Schemes: `KrakiDiag`, `KrakiMacDiag`. Display name Kraki Diag, using the existing DevAppIcon.
All collection types/call sites are inside `#if KRAKI_DIAG`.
The diagnostics identity uses a separate Keychain tag, Defaults, message DB, attachment cache and outbox.
The iOS NSE uses `group.chat.kraki.ios.diag` and a separate keychain entitlement.
Mac's normal Sparkle updates are already restricted by bundle identity, so production updates are never installed over Diag.
Mac window size/zoom settings are still shared across Prod/Dev as originally agreed, so we cannot claim "all UI preferences are fully isolated".

`bash scripts/diag/verify-no-diag.sh <Production.app>` checks the host/NSE bundle IDs and live-code strings.
It is wired into the pre-sign/export steps of the iOS TestFlight / macOS release workflows.
It is a line of defense that works together with real Release build tests; we do not claim a single strings check proves zero leakage for any future implementation.

**Before distribution, register the new Apple App ID/App Group and provisioning profiles, and check the diagnostics APNs topic.**
No certificate/provisioning/store changes this round; a local unsigned build passing does not mean it is installed on a device.

## 5. REST protocol and security

### Routes

- `GET /api/diag/v1/config`
- `POST /api/diag/v1/batch`: `Content-Type: application/json`, `Content-Encoding: gzip`

The reverse proxy forwards directly to the standalone `@kraki/monitor` process, bypassing Head's AccountApi service-key gate.
Head itself no longer serves these REST routes; an old embedded deployment must migrate the proxy first, otherwise it gets 404.
No new Pulse messages, streams, ACKs or Tentacle handlers were added.

### Signature

The app uses the signing key of a successfully signed-in device. Signatures are generated only on the utility queue and never written to diagnostics files.
Request headers:

```
X-Kraki-Device: <deviceId>
X-Kraki-Time: <13-digit UTC milliseconds>
X-Kraki-Request: <UUID; for POST it is the batchId, unchanged on retry>
X-Kraki-Signature: <Base64 RSA PKCS1 v1.5 SHA256 signature>
```

The signed bytes are UTF-8 (joined with newlines, no trailing newline):

```
kraki-diag-v1
<METHOD>
/api/diag/v1/<config|batch>
<deviceId>
<timestamp>
<request UUID>
<lowercase hex SHA256 of the compressed request body; GET uses an empty body>
```

Monitor verifies against registered/mirrored app-role device public keys through a read-only SQLite adapter, with ±5 minutes clock tolerance.
It reads only `devices(id, user_id, role, public_key)`; it does not import Head's Storage types, read conversation messages, or create/migrate/write the Head DB.
It is a write-only diagnostics capability, not general HTTP login; it does not use OAuth, the service Bearer or message E2E keys.
TLS is required; plain HTTP is allowed only for explicit loopback local tests. The client does not follow redirects or send cookies.
A public deployment must have TLS, ingress rate limiting and a dedicated data directory/disk alerting; the data is HTTPS-protected metadata,
**not E2E encrypted**, and the collector can read it. There is no public log download API; analysis uses controlled server file access.

### Input constraints and storage

- ≤64 KiB compressed, ≤256 KiB decompressed, ≤1000 events/batch, schema 1.
- Event name/field name allowlist; format checks for numbers/booleans/IDs/fixed tags; unknown fields reject the whole batch.
- No generic string logs, message text, selected text, drafts, transcripts, URLs, attachments or raw NSError.
- At most 2 concurrent requests; 120/min per IP, 30/min per device; at most 10 seconds to read a request body.
- 20 MiB compressed and 2048 files per device per day; 14-day retention, cleaned at startup/hourly, including inactive devices.
- The directory is measured per device/day on cold start and the quota is cached afterwards, rather than scanning all history on each request.
- Returns 507 when free disk is <1 GiB so logs cannot exhaust the relay DB's space. A deployment-level total disk quota/alerting is still needed.
- Path: `$KRAKI_DIAG_DIR/<SHA256(userId + LF + deviceId)>/<batchId>.json.gz`.
- A retry with the same ID and same bytes returns 204; same ID with different bytes returns 409. Idempotent across restarts/dates.
- Write a temp file, rename, then return 204; the client deletes a batch only after success.
- One Monitor instance owns one directory; distributed quota/write coordination across replicas sharing a directory is **out of scope for v1**.

Operator kill switch: `touch "$KRAKI_DIAG_DIR/DISABLED"`; new POSTs get 410 and GET returns enabled=false.
No relay restart needed. Clients in the foreground fetch config about every 15 minutes and clear caches/stop collecting when disabled (the request after first authentication comes earlier).
Removing the file restores it. Authentication failures/missing endpoints also stop uploads; a later config fetch or re-authentication recovers.
Polling happens only while the user's local switch is on.

## 6. Event format and correlation

Batch (gzip JSON, **not the NDJSON of the early draft**):

```
{ schema: 1, batchId, processId, platform, version, build,
  image: { uuid, base, os, arch },
  events: [{ t, m, seq, ev, sid?, d: {...} }] }
```

- `t` is UTC epoch ms for human comparison; `m` is same-device monotonic ms for in-process intervals.
- `processId` is a UUID per launch, `seq` increments per process. Monotonic values from different processes/devices must not be subtracted.
- `image.uuid/base/arch` are the main executable's Mach-O UUID/load address; keep the matching dSYM to symbolicate stacks.
- Every batch carries full identity metadata and does not depend on receiving launch first; out-of-order batches keep their correlation.
- `ix` is created only in the existing synchronous answer UI callbacks and passed to `cmd.answer/cmd.input`.
- Async handoff, echo, restore and retry are linked by the real `clientId`; there is no "most recent ix" guessing.
- The stacks in `cmd.answer` and `cmd.handoff` are at most 12 return addresses of the **current thread**, not message text or remote sampling of the main thread.
- sessionId/clientId/questionId are correlatable metadata, not fully anonymous data; no names/device names/login names are recorded.

### Currently available events

| Event | Observation point/purpose |
|---|---|
| `ui.mouse` | down/up captured by the existing Mac NSEvent monitor: questionId, eventNumber, clickCount |
| `ui.answer` | iOS/Mac high-level callbacks; the Mac monitor dispatch and the SwiftUI Button are labeled with their source; do not treat logs from different layers as duplicate submissions |
| `cmd.answer` | questionId, byte count, pending count, whether the same question was seen before, stack. duplicate is a diagnostic hint and **does not block** the submission |
| `cmd.input` | the new ID just created by sendInput/stageInput, answerTo, byte count, attachment count, explicit ix; source distinguishes voice staging |
| `cmd.handoff` | AppState handoff result of every send_input (including retry/staged), original answerTo, ID, call stack; accepted does not mean server confirmation |
| `cmd.result` | local result of a new sendInput |
| `outbox.state` | created/restored/retry/cleared/sending/unconfirmed/failed/correcting |
| `echo.input` | seq, clientId, answerTo of the authoritative user_message, and whether it matched the local outbox before cleanup |
| `app.launch/phase` | launch, authentication, active/inactive/background/logout; outbox count when backgrounded |
| `ws.state` | existing connection state callbacks, reconnect count |
| `work.slow` | ≥8 ms iOS list sync/cell configure, Mac list update/cell configure, MessageProvider ingest |
| `diag.health/upload` | bounded queue/rate drop counts, status/bytes of failed uploads; successful uploads do not generate a permanent self-logging loop |

`work.slow` is a **local inclusive span**; nested durations must not be added up. Mac cells currently only have seq, no sessionId,
so they cannot be correlated by cross-session seq alone. It is not a frame hitch, nor a p95 of all functions.
iOS does not observe raw UITouch yet; "no gesture log" does not prove the device saw no second touch.
Lock-contention drops are not counted separately yet; queue/rate drops have counts and seq gaps. Missing logs do not prove an event did not happen.

## 7. Future full observation catalog (to be implemented; do not copy the old draft as-is)

1. **List and bubbles**: mutation/generation ID, stable item key, page request ID, window bounds, counts before and after,
   reload/tail/live/stage branches, pin/drag/decelerating, anchor and programmatic offset corrections.
   Compare measured/actual heights only after layout truly completes, distinguishing estimates, legitimate collapsing, virtualization and anomalies.
   Detect pending/echo by clientId; never dedupe by text, and a failed pending at the bottom is not automatically a bug.
2. **Slow frames/long tasks**: look at the actual refresh budget only while active with animation/interaction demand, filtering ProMotion down-clocking/sleep/background.
   The run loop must distinguish waiting from busy; normal main-thread idle is not a hang. Do scoped work correlation first;
   never pass off the stack at observer end as "the stack while stuck", and no unverified thread suspend/backtrace.
   MetricKit is a delayed supplement, not real-time detection; platform availability and the allowlist need unit tests.
3. **Data flow**: separate spans for decrypt/decode/ingest/DB/layout, cache hits, batch rows, window trims,
   subscription/history request lifecycle. Cross-machine envelope timestamps are only approximations with clock error;
   RTT uses same-process request→ack; Pulse ACK is separate from server persistence/render confirmation.
4. **Navigation/restore**: session-switch generation, cold/warm page open DB/remote/first layout/first pin;
   an app kill cannot always be observed: an unclean previous exit is only a diagnostic clue, not a crash.
5. **Voice**: operation ID, recording/toDraft/staged/dispatched/cancelled, lease availability,
   original/corrected byte counts, latency and result; no transcripts/audio/lease tokens.
6. **Steps/attachments/artifacts/push**: request ID, cache/fetch/decode time, size, chunk count,
   UI display completion, whether a push caused navigation/suppression, read markers. Never record attachment URLs, names, full refs or notification text.
7. **Manual "something just went wrong" marker**: a button in settings/the menu that saves an event marker and visible cell IDs/geometry
   without text. Automatic screenshots/AX text dumps are forbidden; screenshots need separate explicit authorization.
8. **Diagnostics health**: persistently show the last successful upload, cache/eviction/drop counts, remote switch state and current sampling policy.
   Disk failures are counted separately without recursively generating a flood.

The black box comes later: bounded memory keeping about 2 seconds before and 5 seconds after an anomaly, events deduplicated by shared process/seq,
with trigger cooldowns/daily quotas, never temporarily lifting all budgets. **Anomalies are saved locally right away, not uploaded immediately competing for the network.**
"A 200/s cap" and "an unbounded unsampled black box" cannot both be promised.

## 8. Verification and acceptance

### Existing test entry points

```
pnpm test:monitor  # API + readonly WAL integration + isolated built runtime
pnpm --filter @kraki/monitor typecheck
bash scripts/diag/run-native-tests.sh
pnpm exec tsx scripts/diag/local-e2e.ts  # macOS, real Swift RSA/URLSession → standalone loopback Monitor
python3 scripts/diag/timeline.py <local download directory or a single .gz> --question <id>
bash scripts/diag/verify-no-diag.sh <Release.app>
```

NativeTests is a separate optimized build using a URLProtocol mock, temp directories and isolated Defaults; it does not launch the real app,
read the Keychain/production sessions or call models. It covers the bounded queue, concurrent sequence numbers, the switch, gzip, file rolling/recovery,
retention on failure, same-byte retries and stopping on sign-out. Monitor tests cover disabling, signature verification, size/privacy schema, idempotency/conflicts,
quotas, rate limiting, retention and the kill switch.

First implementation verification results (2026-09-27, historical record from before the package split; local, unsigned, unreleased):
- `pnpm lint` and Head TypeScript `--noEmit` pass; the full Head suite **18 files / 277 tests** passes, including 8 new API tests.
- All NativeTests pass; the real loopback E2E used a temporary RSA key, real URLSession and the real collector; the first POST was injected with 503 and only one copy was stored after retry.
- All four combinations of Diagnostics and Release for iOS Simulator arm64 / Mac arm64 build; the final diagnostics code was incrementally rebuilt on both platforms as well.
- Both Release apps pass the release guard; both positive controls (Diag identity, a Diag binary disguised with production metadata) are rejected.
- Native unit tests are wired into the existing macOS CI job; the local E2E script can be run manually.
- No full UI automation regression, signed on-device install or A/B was run; none of these count as passed.

Local benchmark: 100,000 records + a drain every 100, optimized host Swift build, about **0.20–0.33 μs/event**.
This only describes producer enqueue overhead; it excludes stack capture, signing, compression, disk and network, and **cannot be converted into whole-device CPU percentage**.

### Measurement gates required before distribution

- Same physical device, same release-optimized scenarios, Diag off/on A/B: first screen, scrolling, streaming, paging, answering, voice.
- Record p50/p95/p99 main-thread frame/work, RSS, CPU time, energy, storage writes and real compressed traffic.
- Inject RTT/throttling/packet loss; measure extra answer/abort latency while logs upload; target delta p95 <10 ms or <5%,
  a target still to be verified, not an existing guarantee. If not met, defer to idle/manual export.
- Force kill/reopen, lost ACKs, account switching, server disable, disk full, TLS/signature failure, long offline periods and quota rollover across days.
- Build both Release and Diagnostics; normal releases must pass the guard, and Diag must be rejected by the same guard.
- On-device install/sign-in/push verification of the new diagnostics Apple identity; keep a traceable manifest of binary + dSYM + source revision.

## 9. Deployment and exit

The user later authorized this round's release/deploy, carried out per the release addendum at the top. Use the same HTTPS domain as Head, routed separately to Monitor by the reverse proxy; set a private `KRAKI_DIAG_DIR` for Monitor only,
and enable it only after configuring disk quota/alerting/TLS ingress rate limiting; never trial-run deploy commands against production defaults.
Run one diagnostics client at low volume first, then widen the collection catalog; do not turn on all high-frequency logs at once.

When the diagnostics period ends: first disable the collector/client switch, stop distributing Diagnostics, and delete data per the retention policy.
The build isolation and CI guard for normal Release builds stay permanently. To delete uploaded data, delete by owner directory on the server;
turning off the client does not revoke records already uploaded successfully.
