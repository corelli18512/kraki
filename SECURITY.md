# Kraki Security Model

Kraki handles prompts, code, shell commands, and agent output. The goal is to let you use a relay without giving that relay any access to your content.

This document explains what Kraki protects, what it does not protect, and what the relay can still see.

## Short version

- The relay cannot read message contents. All message bodies are end-to-end encrypted.
- The relay sees only what it needs to forward traffic: envelope type, destination device ID, sender device ID, and blob size.
- Endpoints still see plaintext: the machine running the agent and the device reading the session.

## What Kraki is designed to protect

| Threat | How Kraki helps |
|--------|-----------------|
| Relay operator reading content | E2E encryption keeps message bodies on the endpoints |
| Network interception | Clients use TLS / WSS |
| Message tampering | Authenticated encryption (AES-256-GCM) detects modification |
| Unauthorized device access | Pairing, authentication, and device registration control who can join |
| Unauthorized web access | GitHub OAuth code exchange keeps `client_secret` server-side; CSRF state parameter prevents forged callbacks |

## What the relay sees

The relay must route traffic, so it sees some metadata. Here is the complete list:

| Visible to the relay | Why |
|----------------------|-----|
| Envelope type (unicast or broadcast) | Needed to decide fan-out behavior |
| `to` device ID (unicast only) | Needed to route to the right connection |
| Sender device ID (from connection) | Needed to identify origin |
| Blob size | The relay forwards blobs, so size is visible |

That is all. The following are **not** visible to the relay:

- Message content or message type
- Session IDs
- Tool names and agent output
- User input and approval decisions
- Sequence numbers (assigned by tentacle, inside the blob)

Kraki protects content fully, not just partially. The relay is an encrypted forwarder with no ability to inspect payloads.

## What the relay stores

The relay maintains two database tables:

- **users** — user identity and auth records
- **devices** — registered devices and their public keys

The relay does not store messages, sessions, message history, or any content. Message buffering and replay are handled by `tentacle`.

## What Kraki does not protect against

Kraki cannot remove trust from the endpoints themselves.

- If the machine running the agent is compromised, the attacker can see plaintext before it is encrypted.
- If the receiving device is compromised, the attacker can see plaintext after it is decrypted.
- E2E encryption does not hide traffic patterns, activity times, or the metadata listed above.
- A malicious or buggy agent can still misuse the permissions you give it.

## How end-to-end encryption works

Kraki uses:

- **AES-256-GCM** for message content
- **RSA-OAEP (4096-bit)** for per-device key wrapping

At a high level, the flow is:

1. A sender creates a fresh symmetric key for one message.
2. The message body is encrypted with AES-256-GCM.
3. The IV, ciphertext, and authentication tag are concatenated into a single blob: `base64(iv ‖ ciphertext ‖ tag)`.
4. The symmetric key is wrapped separately for each recipient device's public key.
5. The relay forwards the blob and wrapped keys without being able to read them.
6. Each recipient unwraps the symmetric key with its private key and decrypts locally.

This keeps the large payload encryption fast while still allowing multiple receiving devices.

## Device keys

Kraki keeps private keys on the devices that use them.

### Browser / web app

- Keys are generated with the Web Crypto API
- The private key is non-extractable
- Key material is stored locally in browser-managed storage

This makes raw key export harder, but it does not make the browser magically invulnerable. A compromised browser context can still act as that device while it is running.

### CLI / tentacle

- Keys are generated locally on first use
- The private key is stored under `~/.kraki/keys/private.pem`
- File permissions are restricted to the local user

This is local-machine trust, not hardware-backed security.

## New devices and old history

A newly added device cannot automatically decrypt old messages that were encrypted for earlier devices.

To recover that history, an already-authorized online device can re-encrypt stored messages for the new device. If no existing device is online yet, the new device can still receive live traffic immediately and older history can sync later.

That behavior is a normal consequence of per-device encryption.

## Trust summary

| Question | Answer |
|----------|--------|
| Can the relay read message bodies? | No |
| Can the relay see routing metadata? | Yes — envelope type, device IDs, blob size |
| Can the relay see session IDs, message types, or content? | No — all inside encrypted blob |
| Do endpoints see plaintext? | Yes |
| Does the relay store messages? | No — only user and device tables |
| Is self-hosting still useful? | Yes, for operational control and latency |

## Open source and verification

Open source helps because it lets people inspect how Kraki handles encryption, routing, and storage. It does not replace operational trust by itself, but it does make the design auditable and self-hosting possible.

For the runtime picture of how the pieces fit together, read [`ARCHITECTURE.md`](./ARCHITECTURE.md).
