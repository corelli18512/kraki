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
was given. For a device with such an answer from the last 24 hours whose public
key still matches this edge's device mirror:

1. `startChallenge` issues the nonce locally (no network).
2. `verifyChallenge` verifies the signature locally against that public key
   and answers `auth_ok` immediately (`local: true` in the log line).
3. In the background (at most once a minute per device) the edge asks
   `/api/devices/status` about that one device (the account service only
   verifies answers to nonces it issued itself, so the edge's nonce cannot
   be re-verified there). `ok` does not extend the answer's age; a rejection
   (`unknown_device`, `account_deleted`, `wrong_region`, `key_changed`)
   forgets the device and closes its socket, as the 5-minute poll below
   does. Transient errors change nothing.
4. Every 5 minutes the edge posts every cached device (id, the account it
   trusts it for, its signing-key fingerprint) to `/api/devices/status` on
   the account service. Answers: `ok`; `unknown_device` (removed, or the id
   now belongs to another account) → forget + close with that auth error;
   `account_deleted`; `wrong_region` (with the redirect); `key_changed` →
   forget and close (1012) so the device signs in again remotely.

Everything else uses the old remote path unchanged:

- a device this edge has no fresh answer for (first sign-in here, or none
  from the account service within 24 hours);
- a changed encryption key (the account service must store it before others
  encrypt to it; the challenge then comes from the account service too) or a
  signature that does not verify with the cached key (answered with the
  account service's verdict on the device, else retryably: it did not issue
  that nonce);
- a single-use or token credential (pairing, OAuth code, `github_token`).

Local trust only switches on after the account service has answered a
status poll, so an edge deployed before its account service never trusts
locally, and turning the account service's endpoint off turns it off at the
next poll. `KRAKI_EDGE_LOCAL_AUTH=0` disables it on an edge.

## Guarantees and trade-offs

- The account service remains the only authority. The edge never creates a
  device, never assigns a region and never extends trust beyond 24 hours
  without a fresh answer.
- Revocation latency: immediate for removals made on the same edge (the
  device mirror is deleted, which ends local trust), at most one background
  status check after the next sign-in, or one 5-minute poll otherwise.
- Nonces issued locally are single-use, bound to their device, and expire
  after 5 minutes; the Head also rejects any challenge answer (local or
  account-service nonce) older than 5 minutes on that socket. A nonce carries
  its issue time and MACs under the edge's secret (`challenge-nonce.ts`), so
  issuing one stores nothing and no flood of challenge starts can void
  another device's pending nonce; only accepted nonces are remembered.
- Every trust change has an epoch: removal / account deletion on the edge,
  revocation, and every stored account-service answer advance it. An answer
  requested before the latest change is dropped (and a foreground sign-in
  that crossed one fails retryably) so nothing older can revive or
  overwrite newer trust.
- A device id that the account service now assigns to another account
  retires this edge's old mirror and Pulse state before the new owner signs
  in; ids of an account deleted here are tombstoned and never sign in again.
- Only verdicts about the device itself drop local trust; a bad signature
  from some other socket does not.
- Each edge sign-in log line carries `ms: {total, challenge, sign, verify,
  token}` and `/internal/metrics` exposes `authStages` histograms and
  `auth.localChallenge` / `auth.localVerify` / `auth.localRevoked` counters.

## Deploy order

1. Account service (Tokyo) first: adds `/api/devices/status`.
2. Edges (CN): local trust activates at the first successful poll.
