# @kraki/voice-broker

Kraki's product-owned voice authorization and deployment layer. It provides:

- the original standalone Doubao broker and local mock pipeline under `src/`;
- signed Kraki voice-lease verification;
- the production adapter under `deploy/` that plugs Kraki leases into the
  provider-agnostic `@coinfra/voice` gateway while retaining its streaming
  correction and authoritative-final protocol.

The Mac/iOS client never receives provider credentials or the legacy gateway
API key.

```
arm  ─audio→  voice-broker  ─audio→  Doubao
arm  ←text─   voice-broker  ←text─   Doubao
```

This package currently delivers:

- ✅ Doubao binary wire protocol, client, mock server and standalone broker
- ✅ Offline RSA verification of Head-issued, user/device/resource-bound leases
- ✅ One signed lease authorizes a warm WebSocket with many sequential recordings
- ✅ Cumulative `quota_seconds` enforcement and reconnect-safe Head checkpoints
- ✅ Production Coinfra adapter with correction deltas and authoritative final
- ✅ Legacy API-key compatibility for non-Kraki clients on a separate start path
- ✅ File probe and browser microphone test page

---

## Quick start (no Doubao credentials needed)

```bash
# from the worktree root
pnpm install
pnpm --filter @kraki/voice-broker dev all
```

That brings up three things in one process:

| Service       | URL                             | Notes |
| ------------- | ------------------------------- | ----- |
| mock Doubao   | `ws://127.0.0.1:7801/...`       | runs the binary protocol back |
| broker        | `ws://127.0.0.1:7800/voice`     | what `arm` connects to |
| web test page | `http://127.0.0.1:7802/`        | hold-to-talk demo |

Open the web URL in Chrome/Safari, hold the button, speak — you'll see the
mock's scripted transcripts arrive. The wire path through `mic → broker →
DoubaoClient → mock` is identical to the production one through `mic → broker →
DoubaoClient → real Doubao`; only the endpoint differs.

### Probe a file end-to-end

```bash
pnpm --filter @kraki/voice-broker probe -- --mock --file fixtures/your-clip.wav
```

WAV must be 16 kHz mono 16-bit PCM (or pass `--rate` to match). Use ffmpeg
to convert anything else:

```bash
ffmpeg -i in.m4a -ac 1 -ar 16000 -sample_fmt s16 fixtures/your-clip.wav
```

---

## Production Coinfra adapter

`deploy/coinfra-lease-serve.mjs` is the Kraki-owned entrypoint used with a
built `@coinfra/voice` distribution (0.3.0 or later: incremental usage grants).
Configure:

```text
KRAKI_VOICE_LEASE_PUBLIC_KEY_PATH=/path/to/voice-lease.pub.pem
KRAKI_VOICE_SETTLEMENT_URL=http://127.0.0.1:4000/internal/voice/settle
KRAKI_VOICE_SETTLEMENT_KEY=<same secret as Head VOICE_SETTLEMENT_KEY>
KRAKI_VOICE_SETTLEMENT_TIMEOUT_MS=2000
VOICE_API_KEY=<legacy server-only migration key>
```

Kraki clients send the signed lease once in a connection-level `authorize`
frame. Signature, algorithm, issuer, user, device, resource, time window, and
cumulative quota must all match. After `authorized`, the same WebSocket accepts
many sequential `start` / audio / `finish` cycles. Legacy VoiceType clients use
the separate per-start API-key authorizer. Never ship `VOICE_API_KEY` in Kraki
arm builds.

The gateway activates the lease while the app is warming the connection, before
the microphone path. A reconnect installs a new random `activationId` as the
last-writer-wins owner and restores Head's exact cumulative audio checkpoint.
A same-process takeover also transfers any audio not yet checkpointed before it
closes the stale socket. The Broker reports monotonic cumulative `audioSeconds`
during long recordings and after each final transcript, and a final report when
the socket closes.

Head has exactly one limit, `VOICE_DAILY_QUOTA_SEC` (seconds of audio per user
per UTC day). A lease is a device credential (default 24 h), not an allowance:
the budget is granted incrementally. Activation grants 60 s; every usage report
(each 15 s while recording) replies with a renewed cumulative `quotaSeconds`
one chunk ahead while the day's budget lasts, which the gateway applies
(`@coinfra/voice` ≥ 0.3.0). Audio is charged to the UTC
day it is reported on, so a recording across midnight is neither interrupted
nor charged to one day only; lease expiry never cuts a recording in progress.
Idle connections reserve at most one chunk, so concurrent devices never exceed
the cap together. If Head is unreachable a connection can use at most its
current chunk.
Run one broker process per region: a reconnect replaces the lease's previous
owner last-writer-wins and the broker transfers its unreported audio to the new
owner. Across separate processes a replaced socket could use at most its last
60 s chunk unaccounted. Deploy this broker before a Head that signs day-scale leases.
Lower/out-of-order checkpoints are harmless;
checkpoints from replaced owners are rejected. Authorized sockets use standard
WebSocket ping/pong with a 25-second ping cadence and 10-second pong timeout;
there is no application-level keepalive frame. Each Head request has a bounded
timeout (2 seconds by default) plus bounded retries, so authorization fails
closed and graceful shutdown cannot hang forever when Head is unhealthy.

Corrector observability (`@coinfra/voice` 0.3.1+), in the broker journal:

- `corrector corrected` (info): `ms`, `firstMs`, `promptTokens`, `cachedTokens`,
  `completionTokens`, `changed` per correction;
- `corrector failed` (warn): `class` (`billing` = provider usage/spend limit,
  `auth`, `rate_limit`, `timeout`, `server`, `network`, `empty`, `other`);
- `corrector usage` (info, hourly): the day's calls, failures by class and tokens.

```bash
journalctl -u kraki-voice-broker -o cat | grep 'corrector usage' | tail -1
```

Validate the deployment adapter with:

```bash
pnpm --filter @kraki/voice-broker test:deploy
```

---

## Coordinated release requirement

Incremental daily grants (this version) roll out in this order:

1. **Broker first.** Rebuild `deploy/coinfra/` from `@coinfra/voice@0.3.0`,
   deploy this `deploy/kraki-lease-authorizer.mjs`, restart only the broker.
   It works against the current Head: old Heads reply without `quotaSeconds`,
   so the signed per-lease quota keeps applying.
2. **Head.** Charges actual audio per UTC day and renews grants on each usage
   report. Must not run with an old broker: its day-scale leases carry a large
   signed ceiling that only a grant-aware broker narrows to the daily budget.
3. **Apple clients** (Keychain lease, buffered start, idle renewal) ship with
   the next app build; old clients keep working against the new Head.

---

## Commands

```bash
pnpm --filter @kraki/voice-broker mock      # mock Doubao only
pnpm --filter @kraki/voice-broker serve     # broker WSS only
pnpm --filter @kraki/voice-broker web       # static web page only
pnpm --filter @kraki/voice-broker dev       # tsx watch on `serve`
pnpm --filter @kraki/voice-broker probe -- [opts]
pnpm --filter @kraki/voice-broker -- pnpm test
```

Or from the worktree root: `pnpm voice` runs the `all` command (mock + broker +
web in one process).

---

## Wire protocol (arm ↔ broker)

JSON control + binary audio over a single WebSocket. Path: `/voice`.

```
arm → broker
  { "type": "authorize", "uid": "u-1234", "deviceId": "d-1", "authorization": { ...signed lease... } }
  { "type": "start", "uid": "u-1234", "context": { ... } }
  <binary>   16 kHz mono int16 little-endian PCM, ~200ms per chunk
  { "type": "finish" }
  # after sessionFinal, repeat start/audio/finish on the same WebSocket

broker → arm
  { "type": "authorized" }
  { "type": "ready" }
  { "type": "transcript", "text": "...", "finalSegment": false, "sessionFinal": false, "raw": {...} }
  { "type": "transcript", "text": "...", "finalSegment": true,  "sessionFinal": true,  "raw": {...} }
  { "type": "error", "message": "..." }
  { "type": "closed", "code": 1000, "reason": "..." }
```

`raw` exposes Doubao's full JSON for callers that need utterance timings or
word-level breakdowns.

`/healthz` returns `{ ok: true, role: "voice-broker" }` for ops.

---

## Architecture decisions (locked, see handover §2)

- voice-broker = **head's sidecar**: same repo, same host/region, **separate
  process and trust boundary**. Not merged into head (would enlarge blast
  radius and couple bursty audio load to the latency-critical relay).
- **Audio plane never touches core.** arm → nearest regional broker → Doubao,
  all in-region. Control-plane lease minting and activation happen once per
  warm connection; cumulative usage checkpoints are asynchronous.
- MVP cuts all auth/IAP/multi-region. Phase 0-3 prove the vertical slice;
  4-6 layer on after.

## Wire protocol (broker ↔ Doubao)

See `src/doubao.ts` — the file's header comment + the constants block are the
canonical reference. Tests in `src/__tests__/doubao.test.ts` enforce the
encoding/decoding round-trips.
