# Account access and encryption compatibility

## Product policy

Signing in to the account is sufficient to access its online computers. Scanning
a code is an optional sign-in shortcut, not a second authorization gate. The
"Only paired devices" product setting and the plan to enforce it for fresh
installs have been withdrawn.

This policy trusts the Head's account/device authorization. A compromised Head
could add a device to the account. **Do not claim that account-access mode prevents
a malicious relay from reading sessions or commanding a computer.** Encryption
and signature checking remain, but cryptography alone cannot authenticate a new
account device independently of the server.

## What remains unchanged

- The X25519 + HKDF-SHA256 + AES-256-GCM envelope, its bytes, domain labels,
  versions and test vectors.
- Ed25519 signed messages, stored identity keys, existing pinned peer keys and
  signature/replay verification on those connections.
- Existing paired apps continue to receive signed v2 traffic and push previews.
  They are not silently downgraded to unsigned RSA, and no keys are deleted.
- Unpaired apps continue using the existing encrypted RSA compatibility path.
  This change preserves v2; it does **not** claim that every new login already
  negotiates v2. Old iOS/Mac clients, Windows and Web can still sign in normally.
- QR sign-in and same-Mac key enrollment remain available internally to establish
  the existing v2 connection, without being required for account access.
- History remains on the user's computer. This is not cloud history storage.

## App-side replay check (computer → app)

iOS/Mac drop an exact repeat of a signed computer message: same signer and
nonce as one this identity already accepted (`DeviceTrustReplayGuard` in
`DeviceTrust.swift`, one per `EncryptionHandler`, the last 20,000 messages,
in memory). There is deliberately **no age limit**, unlike the tentacle's
15-minute `ReplayGuard`: Pulse may hand a suspended or offline app a message
long after it was signed, and a pending permission or question must still
show. Stale state is handled where it is applied: `session_list` snapshots
older than the last one are ignored, and an approval for a permission that is no
longer pending is refused by the computer. After a relaunch the set is empty,
so messages Pulse redelivers then are processed again, which is how the app
rebuilds its state. Push previews keep their own 24-hour limit.

The web app has no equivalent: it cannot pair, so computers send it unsigned
RSA traffic with no signer or nonce to check.

## Upgrade migration

A shipping `RelayClient` always uses account-access (`compatible`) mode. At
startup, an old enforced `trust/policy.json` is copied once to
`trust/policy.pairing-only.json` (0600), then changed to `enforce:false` through the
existing locked policy writer. A warning records the changed access policy.
Keys, `devices.json`, replay state and all session data are untouched.

The old `KRAKI_DEVICE_TRUST=enforce` and `KRAKI_FRESH_INSTALL_ENFORCE=1` variables
cannot reinstate the gate. `kraki devices enforce on` reports that it is retired;
`off` remains compatible with old scripts. Old paired apps receive a signed
`trusted_devices` response with `enforced:false, policyLocked:true`; their
`set_trust_policy` messages cannot re-enable enforcement.

`kraki devices` lists saved encryption relationships, not the complete set of
account devices authorized to connect. Removing one of those relationships does
not sign the device out; use account Devices settings to remove account access.

The old enforced state machine remains only as an explicit internal fixture
option for cryptographic and old/new transition tests. No shipping CLI/config
path selects it. Historical design and guarantees are in
[e2e-trust-legacy.md](e2e-trust-legacy.md), **not the current security contract**.

## App experience and rollout

Normal device rows no longer label an account computer "Not paired" or offer
pairing-only security controls. The session list does not ask users to scan a
computer's code. "Connect your phone" can complete when an account device comes
online and no longer waits for a signed trusted-device baseline before showing
its sign-in code.

For this rollback, deploy the updated CLI **before** the app UI update where an
old computer has enforcement enabled. An older enforcing computer still owns
its policy: a new app cannot bypass it. The app shows an update-computer hint
instead of asking for another scan. An already established pinned connection
continues to reject unsigned/invalid traffic; downgrade/invalid-key recovery is
not an automatic plaintext or unsigned fallback. A saved-connection failure
remains visible with a confirmed "Reset Saved Connection" action. It warns users
to reset only after an expected change, rather than silently deleting pinned keys
or making a failed/revoked connection impossible to recover from.

## Package ownership

Crypto is maintained in `packages/crypto` (Node, Web Crypto and `SwiftCrypto`),
and Pulse in `packages/pulse` (TypeScript and `SwiftPulse`). Kraki's Xcode project
uses these local Swift packages; Node/Web use the workspace `@kraki/pulse`.
The two Swift package directories have distinct names because SwiftPM derives
package identities from directory names, not only the manifest's display name.

The migration changes ownership, imports and release wiring only. In particular,
`coinfra-crypto/v1 kek` is a **wire domain-separation constant** and is unchanged.
The Swift module name `CoinfraCrypto` is also retained for source compatibility.
External coinfra repositories and existing npm releases are not deleted or
modified. Kraki no longer needs to publish there before changing these libraries.

## Verification

- Node/Web Crypto fresh-envelope interoperability and existing TS/Swift vectors.
- Pulse's shared byte fixtures, TS state-machine/property/real-socket tests, and
  Swift suite (including Kraki's previously vendored hostile-input hardening).
- `packages/tentacle/src/__tests__/device-trust.test.ts`: migrate an enforced
  policy, keep keys/v2 traffic, serve a fresh unpaired account app, reject an old
  app's attempt to turn the gate back on, ignore retired process flags.
- `packages/tests/src/account-access.test.ts`: real isolated Head + Tentacle,
  old enforced policy, fresh account app reads sessions and sends a prompt
  without pairing, with audit backup and unchanged identity.
- Existing signature/replay boundary suites and local-link/integration tests.
- Native app build and tests; no production account or daemon is used.
