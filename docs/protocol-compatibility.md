# Protocol compatibility and removal plan

Kraki has no single protocol version number. Peers negotiate behaviour with
**feature strings** and keep **legacy paths** for older peers. This file is
the one place that lists both, so legacy code is removed on purpose instead of
lingering. Update it whenever you add a feature string or deprecate something.

Old clients stay in use for a long time: iOS users update when the App Store
does, CLI users when they run `kraki update`, and Kraki for Mac bundles its own
tentacle. Remove a legacy path only when **both** conditions in its row hold.

## Feature strings

| Feature | Who advertises | Where | Meaning |
|---|---|---|---|
| `idempotent_input` | tentacle | `device_greeting.features` | `send_input` carrying a `clientId` is applied at most once |
| `fragments` (`PAYLOAD_FRAGMENT_FEATURE`) | tentacle, then app | `device_greeting.features`, `client_features` | large Pulse payloads may be split into fragments (protocol `fragments.ts`) |
| `account_usage` | tentacle | `device_greeting.features` | broadcasts `account_usage` (subscription usage of the computer's agent accounts) |
| `account_usage_refresh` | tentacle | `device_greeting.features` | answers `refresh_account_usage` |
| `pulseProgressAck` | device | auth `device.pulseProgressAck` | understands Pulse progress acknowledgements |

A peer must never send a behaviour the other side has not advertised.

## Deprecated, still supported

| Item | Replaced by | Still produced by | Remove when |
|---|---|---|---|
| `request_session_replay` (app → tentacle) | `request_session_messages` / `request_session_messages_range` | no current client (iOS/Mac removed the unused sender in the 2026-10 review; web never sent it) | the oldest supported iOS/Mac build is from after 2026-10 **and** the tentacle has logged no "deprecated request_session_replay" warning for a release cycle |
| `session_replay_batch` (tentacle → app) | `session_messages_batch` | the tentacle only in answer to `request_session_replay` (import no longer broadcasts it) | together with `request_session_replay`; then drop `handleReplayBatch` in iOS/Mac |
| Session mode wire name `execute` | `auto` | emitters while `EMIT_LEGACY_MODE_NAMES` is `true` (protocol `sessions.ts`) | every supported tentacle, app and web build reads `auto` (all current ones do). Flip the switch to `false`; keep *reading* `execute` one more release |

## How to remove a legacy path

1. Check the "Remove when" condition (App Store build dates, tentacle logs).
2. Remove the emitter first, ship, then the reader in a later release.
3. Bump `@kraki/protocol`'s version in the same PR. The release refuses to
   publish when protocol changed without a version bump
   (`scripts/release/check-published.mjs`).
4. Delete the row here.
