# Kraki Security Model

Kraki handles prompts, code, shell commands, and agent output. The goal is to let you use a relay without giving that relay any access to your content.

This document explains what Kraki protects, what it does not protect, and what the relay can still see.

## Short version

- The relay cannot read message contents. All message bodies are end-to-end encrypted.
- The relay sees only what it needs to forward traffic: envelope type, destination device ID, sender device ID, and payload size.
- Endpoints still see plaintext: the machine running the agent and the device reading the session.
- Account settings are separate from encrypted conversations. Custom Words are stored readably on the account's relay and synced over TLS/WSS; they are **not end-to-end encrypted**. Cloud speech/correction also receives words used for a dictation request.

## What Kraki is designed to protect

| Threat | How Kraki helps |
|--------|-----------------|
| Relay operator reading content | E2E encryption keeps message bodies on the endpoints |
| Network interception | Clients use TLS / WSS |
| Message tampering | Authenticated encryption (AES-256-GCM) detects modification of a message in transit |
| Unauthorized device access | Pairing, authentication, and device registration control who can join |
| Unauthorized web access | GitHub OAuth code exchange keeps `client_secret` server-side; CSRF state parameter prevents forged callbacks |

## What the relay sees

For end-to-end encrypted conversation payloads, the relay sees routing metadata:

| Visible to the relay | Why |
|----------------------|-----|
| Envelope type (unicast or broadcast) | Needed to decide fan-out behavior |
| `to` device ID (unicast only) | Needed to route to the right connection |
| Sender device ID (from connection) | Needed to identify origin |
| Blob size | The relay forwards payloads, so size is visible |

Within those encrypted conversation payloads, the following are **not** visible to the relay:

- Message content or message type
- Session IDs
- Tool names and agent output
- User input and approval decisions
- Sequence numbers (assigned by tentacle, inside the encrypted payload)

The relay is an encrypted forwarder and cannot inspect payloads. See "How devices learn each other's keys" for what it could still attempt and how the apps detect it.

## What the relay stores

The relay maintains account/device data, including:

- **users** — user identity, auth records and account preferences (including readable Custom Words)
- **devices** — registered devices and their public keys
- **push_tokens** — push notification tokens for offline delivery (device token and provider type)

The relay does not store plaintext conversation contents. Message history and replay are handled by `tentacle`. Custom Words are account data, not session data: their spellings and mishearings are persisted in the account's regional relay database and its backups. Synchronizing them does not require any tentacle to be online. Deleted words are removed from the database; existing backups may still contain them.

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
3. The IV, ciphertext, and authentication tag are concatenated into a single payload: `base64(iv ‖ ciphertext ‖ tag)`.
4. The symmetric key is wrapped separately for each recipient device's public key.
5. The relay forwards the payload and wrapped keys without being able to read them.
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

## How devices learn each other's keys

The relay distributes device public keys, so a malicious or compromised relay
could try to hand out its own key instead and read what is encrypted to it.
Kraki limits this:

- The pairing QR code carries a short fingerprint of the computer's key. After
  scanning, the iPhone/Mac app pins the computer whose key matches the QR — the
  QR, not the relay, vouches for it.
- Computers the app first sees without a QR (for example a second computer on
  the same account) are pinned on first use.
- If the relay later reports a different key for a pinned computer, the app
  keeps encrypting to the pinned key and warns the user; nothing is encrypted to
  the new key until the computer is re-paired with a fresh QR code.

Remaining limits: the computer currently trusts phone keys as reported by the
relay, and the web app does not pin keys yet. Both are addressed by the
upcoming key upgrade (E2E v2).

## Who can send commands to your computer

Encryption keeps the relay from **reading** or **modifying** messages. It does
not, on its own, prove **who wrote** a message: encrypting to a computer only
needs the computer's public key, which the relay also holds. Today, the
authenticity of a command rests on two things:

- **Only E2E messages are accepted.** The computer acts on a command only after
  decrypting it. Plaintext frames from the relay, and anything a device places
  inside the head's own plaintext control wrapper (`{from:"@head"}`), are
  dropped; that wrapper may carry only the head's presence/preferences/voice
  control types.
- **The relay binds each message to its sender.** The head stamps every
  forwarded payload with the authenticated device that sent it (`src`) and
  refuses payloads that try to set it themselves. Receivers reject a message
  whose inner `deviceId` differs, so one device on your account cannot pose as
  another.

What this does **not** cover: a compromised relay, or a stolen device that is
still signed in to your account, can compose and encrypt new commands. Closing
that gap needs per-device signatures bound at pairing time (E2E v2, planned).

## New devices and old history

A newly added device cannot automatically decrypt old messages that were encrypted for earlier devices.

To recover that history, an already-authorized online device can re-encrypt stored messages for the new device. If no existing device is online yet, the new device can still receive live traffic immediately and older history can sync later.

That behavior is a normal consequence of per-device encryption.

## Trust summary

| Question | Answer |
|----------|--------|
| Can the relay read message bodies? | No — not passively; key substitution is detected for pinned computers (see above) |
| Can the relay change a message in transit? | No — authenticated encryption detects it |
| Can the relay forge a new command? | Not as plaintext. A compromised relay could still encrypt a command to your computer's public key; per-device signatures (E2E v2) are planned to close this |
| Can the relay see routing metadata? | Yes — envelope type, device IDs, payload size |
| Can the relay see session IDs, message types, or content? | No — all inside encrypted payload |
| Do endpoints see plaintext? | Yes |
| Does the relay store readable conversation messages? | No; account preferences such as Custom Words are a separate, readable data category |
| Is self-hosting still useful? | Yes, for operational control and latency |

## Push notifications and E2E

Push notifications use the same E2E encryption model. When an agent event requires attention and the browser is offline:

1. The tentacle encrypts a small preview (`pushPreview`) with the offline device's public key — the same RSA-OAEP wrapping used for WebSocket messages.
2. The relay forwards the opaque encrypted preview through the push service (APNs or Web Push/VAPID).
3. The device's service worker decrypts the preview locally and shows the notification content.

The relay sees the encrypted payload size and the push token — never the notification content. This extends the same trust boundary from WebSocket delivery to push delivery.

## Image attachments

Images produced by an agent (via the `kraki-show_image` MCP tool) are content-addressed and stored on the tentacle's disk under the session's directory. The bytes are not embedded in agent activity messages — only an attachment reference (id + metadata) appears in the broadcast and in `messages.jsonl`.

Bytes are delivered separately, encrypted per-recipient like any other message:

- Bytes are never pushed. A receiver that needs them (shown or opened) requests them via a `request_attachment` unicast; the tentacle serves chunks back to that specific authenticated device only.
- Report HTML is rendered in a sandboxed web view with a strict CSP (inline scripts/styles only; no network, media, frames or forms). "Open in Browser" writes the original report to a temporary file and opens it outside that sandbox only on explicit user action.

The relay sees the same opaque encrypted payloads it sees for any other message, plus chunked transfer adds nothing to its visibility. Bytes never leave the tentacle except on an authenticated session-member request, so the privacy boundary for screenshots matches the privacy boundary for prompts and tool output.

## Voice input

Voice input is the one feature that is **not** end-to-end encrypted. The first time someone dictates, the app says so and asks them to continue.

- **Audio** goes to Kraki's cloud speech service (a `wss://*.kraki.chat` broker; the apps refuse any other broker the relay might advertise). It is transcribed by a cloud speech-recognition provider.
- **Correct Transcripts** (on by default): the transcript is sent to an AI model that fixes recognition mistakes. With it go the user's Custom Words and, if **Use Conversation Context** is on (default), the conversation title, agent, model and up to 32 names or terms taken from the last 12 messages.
- Conversation terms are filtered on the device: whole messages are never sent, and anything shaped like a credential (GitHub/Slack/OpenAI-style tokens, AWS key ids, JWTs, PEM blocks), a URL, host:port, e-mail address, file path, long hex string or high-entropy token is dropped. See `VoiceContextTermFilter`.
- Both switches are in Settings → Voice Input. With context off, only Custom Words and the locale accompany the transcript.
- The relay authorizes each voice connection with a signed, quota-limited lease.

## Local MCP server

The tentacle runs a small loopback HTTP server (the Kraki MCP server) so the local agent can call Kraki-specific tools such as `kraki-show_image`. It binds to `127.0.0.1` only, requires a per-session bearer token, and is registered with the agent via a per-session URL.

The MCP server is not exposed to the relay or to other devices. It is reachable only from processes on the same machine as the tentacle — the same trust zone as the agent itself.

## Open source and verification

Open source helps because it lets people inspect how Kraki handles encryption, routing, and storage. It does not replace operational trust by itself, but it does make the design auditable and self-hosting possible.

For the runtime picture of how the pieces fit together, read [`architecture.md`](./architecture.md).
