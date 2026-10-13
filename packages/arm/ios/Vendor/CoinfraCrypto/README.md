# CoinfraCrypto (vendored)

Swift (CryptoKit) implementation of the `@coinfra/crypto` suite v1
(X25519 + HKDF-SHA256 + AES-256-GCM, Ed25519), used for Kraki's E2E v2.

Source of truth: corelli18512/coinfra `packages/crypto/swift` (PR #23,
branch `feat/crypto-swift`). Copied verbatim; update by copying again.
Byte compatibility with the Node implementation in `packages/crypto/src/v2.ts`
is pinned by `KrakiTests/E2EV2InteropTests.swift`.
