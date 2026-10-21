# Edge-local challenge auth

Regional Heads (edges, e.g. CN) delegate sign-in to the account service
(Tokyo). That stays true for everything that needs the account service to
decide: new devices, pairing, GitHub / token sign-in, region assignment.

What changed is the most common case: a device that the account service has
already verified signing in again (every app reconnect, every return from the
background). Diag 2026-10-12→21 showed 62% of an iPhone's return-to-foreground
time in `ws open → auth_ok` (p50 760 ms), and two cross-border HTTPS round
trips per sign-in (`/api/auth/challenge`, `/api/auth/verify`, 180–350 ms each,
no connection reuse) were most of it.

## How it works

`EdgeAuthCache` (packages/head/src/edge-auth-cache.ts) keeps, per device, the
last successful answer the account service gave this edge, plus the time it
was given. For a device with such an answer from the last 7 days whose public
key still matches this edge's device mirror:

1. `startChallenge` issues the nonce locally (no network).
2. `verifyChallenge` verifies the signature locally against that public key
   and answers `auth_ok` immediately (`local: true` in the log line).
3. In the background (at most once a minute per device) the same signature
   is re-verified at the account service. A definitive rejection
   (`device_not_found`, `account_deleted`, `wrong_region`, …) forgets the
   device and closes its socket with that `auth_error`, exactly what a fresh
   sign-in would have answered. Transient errors change nothing.
4. Every 5 minutes the edge posts all cached device ids to
   `/api/devices/status` on the account service and revokes the ones that
   are no longer `ok` there.

Everything else uses the old remote path unchanged:

- a device this edge has no fresh answer for (first sign-in here, or none
  from the account service within 7 days);
- a changed encryption key (the account service must store it before others
  encrypt to it) or a signature that does not verify with the cached key;
- a single-use or token credential (pairing, OAuth code, `github_token`).

Local trust only switches on after the account service has answered a
status poll, so an edge deployed before its account service never trusts
locally, and turning the account service's endpoint off turns it off at the
next poll. `KRAKI_EDGE_LOCAL_AUTH=0` disables it on an edge.

## Guarantees and trade-offs

- The account service remains the only authority. The edge never creates a
  device, never assigns a region and never extends trust beyond 7 days
  without a fresh answer.
- Revocation latency: immediate for removals made on the same edge (the
  device mirror is deleted, which ends local trust), at most one background
  re-verification after the next sign-in, or one 5-minute poll otherwise.
- Nonces issued locally are single-use, bound to their device, and expire
  after 5 minutes.
- Each edge sign-in log line carries `ms: {total, challenge, sign, verify,
  token}` and `/internal/metrics` exposes `authStages` histograms and
  `auth.localChallenge` / `auth.localVerify` / `auth.localRevoked` counters.

## Deploy order

1. Account service (Tokyo) first: adds `/api/devices/status`.
2. Edges (CN): local trust activates at the first successful poll.
