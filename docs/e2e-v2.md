# E2E v2 (X25519) — phase 1: dual format, opt-in sending

Suite: `@coinfra/crypto` v1 — per-recipient ephemeral X25519 + HKDF-SHA256 key
wrap, AES-256-GCM payload, compact self-describing envelope. Implementations:
`packages/crypto/src/v2.ts` (node:crypto, synchronous, Tentacle) and
`packages/arm/ios/Vendor/CoinfraCrypto` (CryptoKit, vendored from coinfra PR #23).

## Wire
Pulse payload `{ "v": 2, "blob": <base64url envelope> }`; legacy RSA stays `{ blob, keys }`.
Both are always accepted by Tentacle and the Mac/iOS apps. Web is unchanged (RSA only).

## Keys — exchanged in the existing handshake (no Head / schema change)
- Tentacle: `~/.kraki/keys/e2e-x25519.key` (PKCS#8, 0600); greeting carries
  `e2eKeys.x25519` always and `e2e_v2` in `features` only when sending is enabled.
- App: `client_features` carries `e2eKeys.x25519` and `e2e_v2` (sent per connection).
  iOS keeps the key in the shared Keychain group (NSE-readable); macOS uses a per-process key.
- Trust is unchanged: keys arrive inside the RSA E2E channel whose keys the Head distributes.

## When v2 is sent
- Tentacle → apps: `KRAKI_E2E_V2=1` (or `RelayClientOptions.e2eV2`) **and** every
  target app announced a key and `e2e_v2` on its current connection; otherwise RSA.
  A reconnect (`device_joined`) forgets the announcement until the next `client_features`.
- App → Tentacle: the Tentacle advertised `e2e_v2` and a key in its greeting.
- Push previews stay RSA (NSE does not decrypt v2 yet).

## Verified
Cross-implementation vectors (node ⇄ @coinfra TS ⇄ Swift); Tentacle and Swift unit
tests; chaos stack (real Head + Tentacle, native Mac app) with `KRAKI_E2E_V2=1`:
S0/A1/A2 pass, v2 used both ways (v2In 50, v2Out 108); off: zero v2.

## Later phases
Push preview v2, Ed25519 auth signatures at the Head, then retire RSA.
