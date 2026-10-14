# CryptoKit implementation of Kraki's encryption protocol

This package is owned here, alongside the Node and Web Crypto implementations
in `packages/crypto`. It is no longer a periodically copied external dependency.
The Swift module name `CoinfraCrypto` is retained for source compatibility.

X25519 + HKDF-SHA256 + AES-256-GCM envelopes and Ed25519 signatures are unchanged.
The cryptographic domain label `coinfra-crypto/v1 kek` and other wire constants
must remain byte-identical. Package names do not define protocol versions.

Run `swift test --package-path packages/crypto/SwiftCrypto` from the repository root.
Shared vectors live in `packages/crypto/src/__tests__/fixtures` and are also read
by the Node, Web Crypto and native app interoperability tests.
