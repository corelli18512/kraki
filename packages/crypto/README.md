<p align="center">
  <a href="https://github.com/corelli18512/kraki">
    <img src="https://raw.githubusercontent.com/corelli18512/kraki/main/logo.png" alt="Kraki" width="140">
  </a>
</p>

<p align="center">
  <a href="https://github.com/corelli18512/kraki">GitHub repository</a>
</p>

# @kraki/crypto

End-to-end encryption helpers for Kraki.

> Preview: `@kraki/crypto` is still evolving with the rest of the protocol and device model.

This package provides the Node.js crypto primitives used by Kraki for multi-recipient message encryption and challenge-response signing.

## Install

```bash
npm i @kraki/crypto
```

## What it includes

- RSA-OAEP key generation
- AES-256-GCM payload encryption
- per-recipient wrapped keys for multi-device delivery
- compact public-key export/import helpers
- challenge signing and verification helpers

## Example

```ts
import { generateKeyPair, encrypt, decrypt } from '@kraki/crypto';

const alice = generateKeyPair();

const payload = encrypt('hello from kraki', [
  { deviceId: 'alice', publicKey: alice.publicKey },
]);

const plaintext = decrypt(payload, 'alice', alice.privateKey);
```

This package currently targets Node.js via the built-in `crypto` module.

## Links

- Main docs: `https://github.com/corelli18512/kraki/blob/main/README.md`
- Security model: `https://github.com/corelli18512/kraki/blob/main/SECURITY.md`
