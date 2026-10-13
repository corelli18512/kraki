# Device trust (E2E v2) — POC

Goal: **a compromised relay (Head) can neither read conversations nor command
a computer.** Kraki-the-company acting maliciously (shipping a bad client) is
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

| | compatible (default) | enforce (`KRAKI_DEVICE_TRUST=enforce`) |
|---|---|---|
| paired apps | signed X25519 both ways; unsigned in their name rejected | same |
| unpaired apps | legacy RSA, unsigned (as today) | receive only a signed `trust_required`; every command rejected |
| pairing | accepted | accepted |

Apps: a paired computer is always signed/X25519; unpaired computers stay on
the legacy path. An unsigned message attributable to a paired computer (by
`src`, `deviceId` or session ownership) is dropped.

Migration: ship compatible; every app pairs (QR re-scan / automatic on the
same Mac); then enforce. Existing devices must re-pair — there is no implicit
trust of previously known devices.

## Verified (POC)

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

## Not done (POC limits)

- **Web app**: no device trust; unusable against an enforcing computer.
- **Push previews** stay RSA and unsigned (the Head could spoof a notification
  text, not read one). NSE needs X25519 + signature verification.
- **Adding a computer** requires a QR scan or the same-Mac path; approving a
  new device from an already paired one is not implemented.
- **UI**: pairing state is in `TentacleTrustStore` only (no badge/flow yet);
  pairing secrets on iOS live in UserDefaults until confirmed.
- **Head-originated destructive control**: `account_deleted` still makes the
  computer forget its credentials and keys (a DoS, not a takeover).
- App-side replay protection (computer→app) and key rotation are not implemented.
