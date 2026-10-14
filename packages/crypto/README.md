<p align="center">
  <a href="https://github.com/corelli18512/kraki">
    <img src="https://raw.githubusercontent.com/corelli18512/kraki/main/logo.png" alt="Kraki" width="140">
  </a>
</p>

<p align="center">
  <a href="https://github.com/corelli18512/kraki">GitHub repository</a>
</p>

# @kraki/crypto

Encryption helpers owned and maintained in the Kraki monorepo.

- `src/v2.ts`: synchronous Node X25519/HKDF-SHA256/AES-256-GCM envelope.
- `src/web/` (`@kraki/crypto/web`): asynchronous Web Crypto implementation.
- `SwiftCrypto/`: CryptoKit implementation (module name `CoinfraCrypto` retained for source compatibility).
- `src/trust.ts`: Ed25519 message signatures and replay helpers.
- `src/__tests__/fixtures/`: canonical cross-language vectors.

The Web Crypto implementation was imported from `corelli18512/coinfra` at
`e23b2f8ef093605186cb910663778e0b711d8bfe` (crypto 0.2.0); Swift is the implementation
already shipped by Kraki. Kraki is now the source of truth for all three.
Historical wire identifiers (including `coinfra-crypto/v1 kek`) are protocol
constants, not repository names: do not rename them when moving code.
See `ENVELOPE.md` for the imported envelope specification. The old external npm
package is not required to build or release Kraki.

The legacy RSA APIs below remain available for older clients.

> Preview: `@kraki/crypto` is still evolving with the rest of the protocol and device model.

This package provides the Node.js crypto primitives used by Kraki for multi-recipient message encryption, blob encoding, and challenge-response signing.

## Install

```bash
npm i @kraki/crypto
```

## What it includes

- RSA-OAEP 4096-bit key generation
- AES-256-GCM payload encryption
- per-recipient wrapped keys for multi-device delivery
- blob encoding: `base64(iv ‖ ciphertext ‖ tag)`
- blob-level encrypt/decrypt helpers
- compact public-key export/import helpers
- challenge signing and verification helpers

## Blob API

### `encryptToBlob(plaintext, recipients)` → `{ blob, keys }`

Encrypts a plaintext string for one or more recipients. Returns a single base64 blob (`iv ‖ ciphertext ‖ tag`) and a map of wrapped AES keys, one per recipient device.

### `decryptFromBlob({ blob, keys }, deviceId, privateKey)` → `plaintext`

Decrypts a blob using the calling device's private key. Looks up the wrapped key by `deviceId`, unwraps it with RSA-OAEP, and decrypts the blob.

### `payloadToBlob(payload)` → `blobPayload`

Converts a legacy separated payload (iv, ciphertext, tag, keys) into the consolidated blob format.

### `blobToPayload(blobPayload)` → `payload`

Converts a blob payload back into separated fields. Useful for interop or debugging.

## Blob format

The blob is a single base64 string encoding the concatenation of:

1. **IV** — 12 bytes (AES-256-GCM initialization vector)
2. **Ciphertext** — variable length
3. **Tag** — 16 bytes (GCM authentication tag)

This keeps the wire format compact — one string instead of three separate fields.

## Example

```ts
import { generateKeyPair, encryptToBlob, decryptFromBlob } from '@kraki/crypto';

const alice = generateKeyPair();

const { blob, keys } = encryptToBlob('hello from kraki', [
  { deviceId: 'alice', publicKey: alice.publicKey },
]);

const plaintext = decryptFromBlob({ blob, keys }, 'alice', alice.privateKey);
```

This package currently targets Node.js via the built-in `crypto` module.

## Links

- Main docs: `https://github.com/corelli18512/kraki/blob/main/README.md`
- Security model: `https://github.com/corelli18512/kraki/blob/main/SECURITY.md`
