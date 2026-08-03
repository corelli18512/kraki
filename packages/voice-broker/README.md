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
- ✅ Per-session audio limits from signed `quota_seconds`
- ✅ Production Coinfra adapter with correction deltas and authoritative final
- ✅ Migration-safe legacy API-key compatibility for non-Kraki clients; a frame
  carrying a bad lease is never allowed to downgrade to the legacy key path
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
built `@coinfra/voice` distribution. Configure:

```text
KRAKI_VOICE_LEASE_PUBLIC_KEY_PATH=/path/to/voice-lease.pub.pem
KRAKI_VOICE_SETTLEMENT_URL=http://127.0.0.1:4000/internal/voice/settle
KRAKI_VOICE_SETTLEMENT_KEY=<same secret as Head VOICE_SETTLEMENT_KEY>
VOICE_API_KEY=<legacy server-only migration key>
```

Start frames containing `lease` are verified exclusively as Kraki leases:
signature, algorithm, issuer, user, device, resource, time window, and quota
must all match. Frames without `lease` may use the legacy key while older
VoiceType clients migrate. Never ship `VOICE_API_KEY` in Kraki arm builds.

The gateway first activates each `jti` with a random `activationId`; Head accepts
that pair exactly once, preventing lease replay. It then reports trusted
`audioSeconds` exactly once per Kraki session with the same pair. Head reserves
the full lease budget while an activated session is unsettled, then atomically
replaces that reservation with rounded-up actual audio seconds. An expired
never-activated lease releases its reservation; an activated lease whose final
report is lost remains conservatively reserved. Settlement retries are
idempotent and conflicting replays are rejected. Legacy-key VoiceType sessions
have no `jti` and are not reported.

Validate the deployment adapter with:

```bash
pnpm --filter @kraki/voice-broker test:deploy
```

---

## Coordinated release requirement

Head settlement and the Broker activation adapter are one rollout unit. Do not
release only one side while the public voice endpoint remains available: an old
Broker does not activate sessions, and a new Broker cannot settle against an old
Head. For production rollout, first stop accepting new voice connections, then
upgrade both components and configure the matching settlement secret. Start
Head, start the Broker, verify one activation/settlement probe, and only then
restore the public voice route. Database backup and schema-v10 verification are
required before reopening traffic.

## Going live

1. Create a Doubao app at <https://console.volcengine.com/speech> →
   流式语音识别大模型. Note the App Key, Access Key, and Resource ID.
2. Copy `.env.example` → `.env`. Fill in `DOUBAO_APP_KEY`, `DOUBAO_ACCESS_KEY`,
   `DOUBAO_RESOURCE_ID`. **Leave `DOUBAO_MOCK` unset (or `0`).**
3. Run the probe against a real zh-en clip:
   ```bash
   pnpm --filter @kraki/voice-broker probe -- --file fixtures/zh-en-sample.wav
   ```
   This is also the moment to validate the "Doubao is best for mixed
   Chinese+English speech" claim from the handover. If accuracy disappoints,
   the fallback plan is Tencent Cloud realtime ASR (signed-URL auth, which
   deletes the broker entirely — see handover §7).
4. Run the broker live:
   ```bash
   pnpm --filter @kraki/voice-broker serve
   ```

The web test page (and eventually `arm`) connects unchanged.

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
  { "type": "start", "uid": "u-1234", "config": { ... overrides ... } }
  <binary>   16 kHz mono int16 little-endian PCM, ~200ms per chunk
  { "type": "finish" }

broker → arm
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
  all in-region. Control plane (lease minting) is the only thing that hits
  core — and only once per session.
- MVP cuts all auth/IAP/multi-region. Phase 0-3 prove the vertical slice;
  4-6 layer on after.

## Wire protocol (broker ↔ Doubao)

See `src/doubao.ts` — the file's header comment + the constants block are the
canonical reference. Tests in `src/__tests__/doubao.test.ts` enforce the
encoding/decoding round-trips.
