# @kraki/voice-broker

> **Status:** MVP scaffold + full local mock pipeline. Real Doubao credentials not yet
> wired in (waiting on Volcengine console). See `kraki-voice-broker-handover.md`
> in `~/Documents/` for the design background.

The voice-broker is a sidecar process to the Kraki `head`. It holds the
Doubao/Volcengine streaming-ASR secret, accepts audio over WSS from `arm`
clients, and streams transcripts back. The phone never sees the key.

```
arm  ─audio→  voice-broker  ─audio→  Doubao
arm  ←text─   voice-broker  ←text─   Doubao
```

This package currently delivers:

- ✅ Doubao binary wire protocol (frame builders + parser) — pure, unit-tested
- ✅ `DoubaoClient` — WS wrapper with `connect → start → sendAudio → finish`
- ✅ Mock Doubao server — speaks the same binary protocol, lets us test
  end-to-end without real credentials
- ✅ Broker WSS server — bridges arm clients to Doubao (no auth in this phase)
- ✅ Phase-0 probe CLI — stream a local WAV/PCM file, print transcripts
- ✅ Browser mic test page — captures mic → 16 kHz PCM → broker → transcripts
- ⏸ Lease auth / Apple IAP / multi-region sidecar — explicitly deferred
  (handover §5, phases 4-6)

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

## Going live (when credentials arrive)

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
