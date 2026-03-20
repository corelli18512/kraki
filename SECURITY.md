# Kraki Security Model

Kraki handles prompts, code, shell commands, and agent output. The goal is to let you use a relay without automatically giving that relay full access to your content.

This document explains what Kraki protects, what it does not protect, and what each deployment mode still asks you to trust.

## Short version

- In end-to-end encrypted mode, the relay cannot read message contents.
- In trusted self-hosted mode, the relay can read stored contents because you are operating the server.
- In both modes, the endpoints still see plaintext: the machine running the agent and the device reading the session.
- In both modes, the relay still sees routing metadata.

## What Kraki is designed to protect

| Threat | How Kraki helps |
|--------|-----------------|
| Relay operator reading content | End-to-end encryption keeps message bodies on the endpoints |
| Network interception | Clients use TLS / WSS |
| Message tampering | Authenticated encryption detects modification |
| Unauthorized device access | Pairing, authentication, and device registration control who can join |
| Unauthorized web access | GitHub OAuth code exchange keeps `client_secret` server-side; CSRF state parameter prevents forged callbacks |
| Lost connection or reconnect gaps | Sequence numbers and replay reduce message loss and duplication |

## What Kraki does not hide

Even in end-to-end encrypted mode, the relay still sees some metadata because it must route traffic and maintain state.

| Still visible to the relay | Why |
|----------------------------|-----|
| Device IDs and device names | Needed for routing and device management |
| Channel membership | Needed to know which devices belong together |
| Timestamps and message ordering | Needed for replay and delivery order |
| Message sizes | The relay forwards blobs, so size is visible |
| Recipient lists and public keys | Needed to deliver encrypted content to the right devices |
| Session IDs | Needed to route actions back to the correct agent machine |
| Limited session hints | Some outer-envelope fields remain visible for routing and session state, such as agent/model on session creation and selected state markers |

That means Kraki protects content more strongly than metadata. It is honest to describe the relay as unable to read message bodies, not as unable to learn anything at all.

## What Kraki does not protect against

Kraki cannot remove trust from the endpoints themselves.

- If the machine running the agent is compromised, the attacker can see plaintext before it is encrypted.
- If the receiving device is compromised, the attacker can see plaintext after it is decrypted.
- If you run a trusted self-hosted relay, the relay can read stored content because that is the model you chose.
- End-to-end encryption does not hide traffic patterns, activity times, or other metadata listed above.
- A malicious or buggy agent can still misuse the permissions you give it.

## Two operating modes

### Trusted self-hosted mode

Use this when you control the relay and want the simplest operational model.

- Transport is still protected with TLS / WSS
- The relay stores plaintext session content
- Search and debugging are simpler
- You are explicitly trusting the relay operator

This is a good fit for a private server, home lab, or internal team deployment.

### End-to-end encrypted mode

Use this when you want the relay to deliver messages without being able to read their contents.

- Each device has its own keypair
- Senders encrypt content before it reaches the relay
- The relay stores ciphertext plus routing metadata
- Receivers decrypt locally

This is a better fit for hosted or shared relays where you do not want to trust the operator with message bodies.

## How end-to-end encryption works

Kraki currently uses:

- **AES-256-GCM** for message content
- **RSA-OAEP (4096-bit)** for per-device key wrapping

At a high level, the flow is:

1. A sender creates a fresh symmetric key for one message.
2. The message body is encrypted with AES-256-GCM.
3. That symmetric key is wrapped separately for each recipient device's public key.
4. The relay stores the encrypted message plus the wrapped keys.
5. Each recipient unwraps the symmetric key with its private key and decrypts locally.

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

In end-to-end encrypted mode, a newly added device cannot automatically decrypt old messages that were encrypted for earlier devices.

To recover that history, an already-authorized online device can re-encrypt stored messages for the new device. If no existing device is online yet, the new device can still receive live traffic immediately and older history can sync later.

That behavior is a normal consequence of per-device encryption.

## Practical trust summary

| Question | Trusted self-hosted | End-to-end encrypted |
|----------|---------------------|----------------------|
| Can the relay read message bodies? | Yes | No |
| Can the relay see routing metadata? | Yes | Yes |
| Do endpoints see plaintext? | Yes | Yes |
| Is self-hosting still useful? | Yes, for operational control | Yes, if you want both control and content privacy |

## Open source and verification

Open source helps because it lets people inspect how Kraki handles encryption, routing, and storage. It does not replace operational trust by itself, but it does make the design auditable and self-hosting possible.

For the runtime picture of how the pieces fit together, read [`ARCHITECTURE.md`](./ARCHITECTURE.md).
