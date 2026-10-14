# @coinfra/crypto

**Modern hybrid public-key encryption + challenge-response signing. Encrypt one message
to many recipients. Built on the Web Crypto API — runs on browsers, Node, Deno, Bun and
edge runtimes. Zero dependencies.**

`@coinfra/crypto` moves opaque strings: it knows nothing about any application. Give it a
plaintext and a set of recipient public keys, and it returns a compact, self-describing
envelope that only those recipients can open.

## Install

```bash
pnpm add @coinfra/crypto
```

Requires a runtime with the Web Crypto API and X25519/Ed25519 support (Node 20+, Deno,
Bun, and current browsers).

## Cipher suite (v1)

| Layer | Algorithm |
|---|---|
| Key encapsulation | ephemeral **X25519** ECDH + **HKDF-SHA256** (HPKE-style) |
| Payload & key wrap | **AES-256-GCM** |
| Signatures | **Ed25519** |

Every envelope carries a version + suite identifier, so the scheme can evolve without
breaking existing ciphertext.

## How it works

A fresh 256-bit content key encrypts the payload with AES-256-GCM. That content key is
then wrapped **independently for each recipient**: a per-recipient ephemeral X25519 key
does ECDH against the recipient's public key, HKDF-SHA256 derives a wrapping key, and
AES-256-GCM seals the content key. Each recipient reverses only their own wrap, then
decrypts the single shared ciphertext. GCM's auth tag makes any tampering — payload,
nonce, or a wrapped key — fail loudly.

All operations are asynchronous (the Web Crypto API is promise-based).

## API

### Keys

```ts
import { generateEncryptionKeyPair, generateSigningKeyPair } from '@coinfra/crypto';

const enc = await generateEncryptionKeyPair(); // X25519,  for encrypt / decrypt
const sig = await generateSigningKeyPair();    // Ed25519, for sign / verify
// each -> { publicKey, privateKey }  (compact base64url strings, wire-ready)
```

Encryption and signing use separate key pairs by design.

### Encrypt to many recipients

```ts
import { encrypt, decrypt } from '@coinfra/crypto';

const envelope = await encrypt('hello', [
  { recipientId: 'alice', publicKey: alice.publicKey },
  { recipientId: 'bob', publicKey: bob.publicKey },
]);

await decrypt(envelope, 'alice', alice.privateKey); // 'hello'
await decrypt(envelope, 'bob', bob.privateKey);     // 'hello'
```

`recipientId` is an opaque label you choose (a user id, device id, key id — anything).

### Compact self-contained blob

```ts
import { encryptToBlob, decryptFromBlob } from '@coinfra/crypto';

const blob = await encryptToBlob('hello', [
  { recipientId: 'alice', publicKey: alice.publicKey },
]);
// blob is a single base64url string containing everything needed to decrypt

await decryptFromBlob(blob, 'alice', alice.privateKey); // 'hello'
```

`serializeEnvelope(envelope)` / `deserializeEnvelope(blob)` convert between the structured
`Envelope` object (JSON-friendly) and the compact binary blob directly.

### Challenge-response signing

```ts
import { signChallenge, verifyChallenge, canonicalJson } from '@coinfra/crypto';

const canonical = canonicalJson({ sub: 'user', exp: 2000 }); // stable, recursively sorted
const signature = await signChallenge(canonical, sig.privateKey);
await verifyChallenge(canonical, signature, sig.publicKey);  // true
```

`verifyChallenge` never throws — it returns `false` on any malformed input.

`canonicalJson` produces RFC 8785-aligned output (recursively sorted keys, no insignificant
whitespace) so both sides sign byte-identical bytes regardless of key insertion order.

## Envelope format

```ts
interface Envelope {
  v: number;          // format version (1)
  suite: string;      // 'X25519-HKDF-SHA256/AES-256-GCM'
  iv: string;         // base64url payload nonce
  ciphertext: string; // base64url ciphertext ‖ tag
  recipients: Record<string, { epk: string; key: string }>; // keyed by recipientId
}
```

`serializeEnvelope` packs this into `magic ‖ version ‖ suite ‖ …` and base64url-encodes it;
`deserializeEnvelope` validates the header and rejects anything it doesn't recognize.
