# POC: choose the sign-up region by measured latency

Today the relay looks up a new user's country with ip-api.com, over plain
HTTP, and maps it through a hand-written country table (JP/KR/SEA/AU → china,
everything else → us). That approach sends the user's IP to a third party
unencrypted, breaks ip-api's free-tier terms, guesses from geography instead
of measuring the network, and needs a code change for every new region.

## What the POC does (`packages/tentacle/src/region-probe.ts`)

1. **Live region list.** `GET {main server}/api/regions`, a public endpoint
   that already returns `{version, ttlSec, regions[]}`. No region is
   hard-coded, so adding a region to the server is enough.
2. **Measure each region in parallel**, over the same path the daemon will
   use later (system or env proxy, or direct). It opens a real WebSocket to
   the relay URL, then sends 5 WebSocket ping frames 60 ms apart. The relay
   answers pings at the protocol level, before sign-in, with no new endpoint
   needed.
3. **Pick the lowest median round trip.** Ties within 10% keep the server's
   order. Unreachable regions are skipped. If nothing answers, there is no
   preference and the server decides, as today.

Try it: `pnpm --filter @kraki/tentacle exec tsx scripts/region-latency-poc.ts [--direct]`

## Results (2026-10-10, live list v1791621876: china, us)

| Vantage point | china (median RTT) | us (median RTT) | Pick (3 rounds) | Time |
|---|---|---|---|---|
| Mainland China, via local rule-based proxy | 8–10 ms | 103–112 ms | china ×3 | ~1.2 s |
| Mainland China, direct | 8–10 ms | 99–106 ms | china ×3 | ~1.2 s |
| GitHub runner, macOS (US) | 161–163 ms | 107–108 ms | us ×3 | 1.7–2.7 s |
| GitHub runner, Windows (US) | 209–220 ms | 109–110 ms | us ×3 | 2.5–3.2 s |
| GitHub runner, Linux (US) | 258–271 ms | 158 ms | us ×3 | 2.5–3.8 s |

- Every vantage point picked the same region in all rounds, and the margins
  are large (≥ 50 ms).
- Single outlier samples (570 ms, 877 ms) appeared; the median ignores them.
- Total time is dominated by opening the far region's socket. Capping it at
  ~2 s would lose nothing (the far region is the one we don't want anyway).

## Caveats

- **A full-tunnel VPN at sign-up time** routes everything through the tunnel,
  so the measurement reflects the VPN exit and picks that region. That
  matches where the traffic really goes at that moment, but the assignment is
  permanent. Mitigations: show the server in Settings, and later allow moving
  the account. A rule-based proxy (as tested above) is not a problem.
- The client's measurement is advisory. The server still checks that the
  region exists and is enabled.

## To ship it (not done in the POC)

1. **CLI setup**: run `probeRegions` while the user signs in with GitHub (it
   overlaps the device-code wait, so it costs no visible time). Send the
   result as `preferredRegion` in `POST /api/login/resolve`; the server
   already accepts it.
2. **iOS / Mac**: the same measurement in Swift (`URLSessionWebSocketTask`
   has `sendPing`), sent with the GitHub sign-in or pairing.
3. **Server fallback** for old clients or failed measurements: replace the
   ip-api.com call with an offline country database (DB-IP Lite, free with
   attribution), so no IP leaves the relay. Or drop geo entirely and use the
   default region.
4. **Settings**: show "Server: China / US".

Effort: CLI ½ day, iOS/Mac ½–1 day, server fallback ½ day.
