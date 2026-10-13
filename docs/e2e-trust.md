# Device trust (E2E v2)

Goal: **a compromised relay (Head) can neither read conversations nor command
a computer** — for a computer with "Only paired devices" on (enforce). In
compatible mode a paired app's own traffic is protected, but the computer still
serves unpaired devices of the account, which a compromised relay can add. Kraki-the-company acting maliciously (shipping a bad client) is
out of scope: E2E cannot defend against the party that ships the clients.

Before: the Head distributes every device's public key, so it could swap keys
(read) and encrypt new commands to a computer's public key (command). The QR
pinned only the computer's key on the phone; the computer trusted whatever app
keys the Head reported.

## Model

Trust is rooted in **the computer plus one optical pairing**, not in the Head.

| Key | Algorithm | Where | Purpose |
|-----|-----------|-------|---------|
| identity | Ed25519 | `~/.kraki/keys/identity-ed25519.key`; iOS Keychain; Mac `Application Support/<bundle>/DeviceTrust` (0600) | signs every message |
| encryption | X25519 (`@coinfra/crypto` suite v1) | `~/.kraki/keys/e2e-x25519.key`; same places on apps | per-recipient key wrap, AES-256-GCM |
| legacy RSA | RSA-4096 | unchanged | Head auth challenge; iOS push previews |

None of the new keys is ever sent to the Head.

### Pairing

**QR** — `kraki pair` adds `tid` (computer id), `ik`, `xk` (its keys) and `ps`
(16-byte one-time secret, stored in `~/.kraki/trust/pairings/`, 5 min) to the
existing link. The app pins `ik`/`xk` for `tid`, then sends a `pair_request`
to the computer, encrypted to the pinned `xk`:

```
claim  = {tentacleId, appId, identityKey, encryptionKey, rsaKey?, ts}
proof  = HMAC-SHA256(ps, "kraki-pair/1\n" + fields joined by "\n")
signed by the app's identity key (proof of possession)
```

The computer accepts when the signature verifies with the claimed identity
key, `tentacleId` is itself, the message is fresh, and the proof matches an
unexpired, unused secret (consumed on success). It answers `pair_result`,
signed and encrypted to the enrolled key. The Head never sees `ps`, so it can
neither enroll its own keys nor substitute the app's.

**Same Mac** — Kraki for Mac reads `~/.kraki/device-id` and
`~/.kraki/keys/public-identity.json` (pins the computer), writes its keys to
`~/.kraki/trust/local-enroll/<appId>.json` (0600, owned by the user) and sends
`pair_request` with `local: true`. Only a local process of this user can
write that file.

**Revocation** — `device_removed` from the Head removes trust (removal only
ever takes trust away, so believing the Head is safe).

### Messages

Every message between paired devices is wrapped before encryption:

```json
{"ks":1,"from":"<sender>","to":"<recipient|*>","ts":<ms>,"nonce":"<16B>","body":"<inner JSON>","sig":"<Ed25519>"}
sig over "kraki-sig/1\n" + from + "\n" + to + "\n" + ts + "\n" + nonce + "\n" + body
```

and sent as `{ "v": 2, "blob": <X25519 envelope> }` to the pinned key only.
The receiver verifies the signature with the key pinned for `from`, requires
the Head's `src` stamp to agree, `to` to be itself (or `*`), and — on the
computer — `ts` within −15/+10 min and an unseen nonce (persisted in
`trust/replay.json` across restarts).

## Modes (Tentacle)

| | compatible | enforce ("Only paired devices") |
|---|---|---|
| paired apps | signed X25519 both ways; unsigned in their name rejected | same |
| unpaired apps | legacy RSA, unsigned (as today) | receive only a signed `trust_required`; every command rejected |
| pairing | accepted | accepted |

The mode lives in `~/.kraki/trust/policy.json`, reloaded every 2 s:
- **default (transition release): compatible**, for upgraded *and* fresh
  installs, so every existing app — including apps without device trust, web
  and Windows — keeps working right after upgrading. Paired apps suggest
  turning "Only paired devices" on once all devices are paired. A later
  release makes fresh installs enforce (`freshInstallEnforces()`;
  `KRAKI_FRESH_INSTALL_ENFORCE=1` previews it); an existing policy file always
  wins, so no computer changes mode by upgrading.
- `kraki devices enforce on|off`, or a paired app (signed `set_trust_policy`).
- `KRAKI_DEVICE_TRUST=enforce|compatible` fixes it for the process (tests).

Apps: a computer pinned from a QR/this Mac is always signed/X25519 — from the
moment of pinning, never falling back to the relay's key. Unpinned computers
stay on the legacy path. An unsigned message attributable to a paired computer
(by `src`, `deviceId` or session ownership) is dropped.

## Administration

Paired apps only (signed): `request_trusted_devices`, `revoke_device {deviceId}`,
`set_trust_policy {enforce}`. The computer answers/broadcasts `trusted_devices`
`{enforced, policyLocked, devices[]}` to paired apps. CLI: `kraki devices`
(list + safety code), `kraki devices revoke <id|name>`, `kraki devices enforce on|off`.
`device_removed` from the Head also revokes.

**Safety code**: 12 digits from SHA-256 of the computer's identity key; shown by
`kraki devices` and by the app for its pinned key.

## Push previews

For paired apps the computer signs the preview and encrypts it to the app's
X25519 key; it travels as the app's entry in the preview's `keys` map,
prefixed `v2.` (the Head forwards `{blob, key}` per device unchanged — no Head
change). The iOS Notification Service Extension and Kraki for Mac show it only
if the signature matches a pinned computer, it is addressed to this device and
is less than 24 h old. Unsigned (legacy RSA) previews are never shown once any
computer is pinned — on Mac and in the iOS NSE, which then shows generic text
(also when the push has no usable envelope; the relay's outer alert text and
session id are never used). Legacy and device-trust previews are dispatched
separately so a paired phone's APNs payload carries only its own `v2.` entry;
the summary is shortened until it fits 4 KB. Enforced computers send no legacy
previews at all.

## UI (iOS / macOS)

- Device rows: trust badge (Paired / Pairing… / Pairing failed / Needs pairing / Not paired / Update needed).
- Computer security section (iOS device page; Mac Settings › Devices › badge):
  status and explanation, safety code, "Only paired devices" toggle, devices
  that can control the computer with Revoke, Scan code (iOS) / Paste link / Pair again (this Mac).
- Session list (iOS) / sidebar (Mac): "Pair with <computer>" banner when a computer requires pairing or refused it.
- Toast after scanning/pasting: Pairing… → Paired / Couldn't pair (+ reason).
- Re-scanning a code with a different key for a paired computer asks first.
- Mac "Connect your phone": under enforcement, waits until the phone is paired.
- Logout/sign-in as a new device resets pins and identity keys.

## Verified

- `packages/crypto` trust tests + Node⇄Swift vectors (signature, pairing proof, X25519).
- `packages/tentacle/src/__tests__/device-trust.test.ts` — a full-strength
  malicious Head (any payload, any `src`, injected `device_joined`, sees all
  output): forged unsigned / foreign-signed / replayed / re-stamped commands,
  Head-added devices, enrollment without the secret, key swap, revocation,
  local enrollment checks, compatible-mode migration.
- `KrakiMacTests/DeviceTrustE2ETests` via `bash scripts/chaos/run-trust.sh`:
  production Swift networking against a real Head + enforcing Tentacle — QR
  pairing, one-time secret, same-Mac pairing, commands round-trip, a rogue
  account device is refused.

## Hardening from the review round (2026-10-13)

GPT-6.1 line-by-line review (REV-01…09) and trust-boundary test suites
(packages/tentacle/src/__tests__/trust-boundary-tentacle.test.ts, 78 cases;
KrakiTests/DeviceTrustBoundaryTests.swift, 28+ cases) found and now pin:
- Apps: a pin protects from the moment of pinning (pending/refused too);
  pair_result / trusted_devices / trust_required must carry the pinned
  computer's signature (`__krakiSignedBy`, set only by verification); unsigned
  messages must name a sender and may not touch a pinned computer's session
  anywhere in the message (top level, payload, session lists, previews); an
  opened link with other keys for any pinned computer asks first.
- Tentacle: policy loaded before the first relay frame on fresh installs;
  unreadable policy fails closed (enforce); re-pairing / lost pair_result
  retries reach the pairing handler (idempotent for identical keys); nonces
  persisted synchronously before acting (fail closed if unwritable); unreadable
  replay state rejects everything signed before startup; trust-store writes
  are locked read-modify-write (no resurrecting revoked apps); unsigned
  messages claiming a paired app by deviceId are refused in compatible mode;
  trust administration must be addressed to this computer (not `*`); Head
  control wrappers are refused on the local link even when fragmented; a local
  enrollment must be consumed before trust is granted; upgraded installs
  create device-trust keys at startup (same-Mac pairing).

## Compatibility (transition release)

| | old CLI | new CLI (compatible, default) | new CLI (enforce, opt-in) |
|---|---|---|---|
| old iOS/Mac app, web, Windows | ✓ | ✓ unpaired, as today | ✗ until updated and paired |
| new iOS/Mac app | ✓ unpaired ("Update needed") | ✓ paired after a QR scan / automatically on the same Mac; unpaired until then | ✓ once paired |

- No Head change: the current relay forwards everything (push previews
  included) unchanged.
- Old apps ignore the new QR parameters and greeting fields.
- Downgrading a computer to an old CLI after pairing: the app sees unsigned
  messages from a paired computer, drops them and shows "Not signing" with
  **Forget Pairing** (a signed message from the computer clears the warning).
  Forgetting returns this device to the unpaired connection.
- Mixed setups: notifications from unpaired computers show generic text on
  apps that paired with any computer.
- Recommended order: release the apps first, then the CLI.

## Hardening from review round 2 (2026-10-13)

Three read-only GPT reviews (protocol, apps/UI, end-to-end design) found 24
items, all addressed with regression tests:
- Fresh-install policy written before the RSA key becomes visible (no race or
  interrupted start can persist "compatible").
- Replay state v2 `{notBefore, highWater, entries}`: validated on load; lost or
  malformed state rejects everything up to now + max clock lead and persists
  that floor; clock rollback cannot reopen pruned nonces.
- Signed/HMAC'd fields are delimiter-free (`isWireId`, canonical 16-byte nonce),
  in TS and Swift.
- Policy has a revision; `set_trust_policy` must name the current one (a
  withheld older request cannot undo a newer choice); apps show "Applying…"
  until the computer's signed list confirms, and report a timeout.
- Trust-store writes that absorb another process's change re-evaluate access.
- Apps: key-change confirmation on every path incl. cold launch; in-session
  pairing only for this account's computers (else account switch); a pinned
  computer's signed session list takes sessions back from unpinned claimants;
  broadcast sealing failure never falls back to relay keys; pairing retries
  every ~10 s while pending; Mac "Connect your phone" treats unknown policy as
  pending; copy only promises relay exclusion when enforcement is confirmed.
- iOS test target compiles the shipped NSE source (no generated wrapper).

## Not done

- **Web app** and **Windows-specific** checks: deferred. Web cannot pair; an enforcing computer does not serve it.
- **Adding a computer** requires a QR scan / pasted link or the same-Mac path;
  approving a new device from an already paired one is not implemented.
- **Head-originated destructive control**: `account_deleted` makes the computer
  forget credentials and keys; `device_removed` revokes trust (DoS, not takeover).
- App-side replay protection (computer→app) and key rotation are not implemented.
- In mixed setups (some computers paired, some not) unpaired computers'
  notifications show generic text on iOS/Mac.
- Before a pinned computer's signed session list arrives, a session the relay
  attributed to an unpinned device is treated as that device's (it is taken
  back as soon as the signed list arrives).
