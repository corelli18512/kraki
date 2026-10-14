# Mac local link (POC)

Status: proof of concept on branch `poc/mac-local-direct`. Not released.

## Problem

Kraki for Mac usually runs a Tentacle on the same Mac, either the built-in
helper or a CLI install. Before this POC, every byte between the two went
App → Head (Tokyo/CN) → Tentacle and back, even though both processes share
a machine.

## Design

```text
App ⇄ Head ⇄ Tentacle             identity, device list, presence, other computers, push, voice, prefs
App ⇄ ws://127.0.0.1:<port> ⇄ Tentacle   all App⇄this-Tentacle traffic (the local link)
```

The local link replaces only the Head hop for one App⇄Tentacle pair. Above the
transport, nothing changes:

- **Payloads** are the same E2E `{blob, keys}` ciphertext the Head would carry.
  The App's decrypt and route path does not change. The link stamps `src` the
  way the Head does, so the existing sender check still applies.
- **Reliability**: each link connection gets its own Pulse StreamSet (live +
  bulk). Both sides reuse the classes that already serve the Head hop
  (`TentaclePulse` / `PulseManager`). A new connection gets a new epoch. Like a
  Head `device_joined`, the Tentacle then sends greeting + usage +
  `session_list`. That `session_list` is the App's new subscription barrier.
- **Routing (Tentacle)**: `sendPayload` sends every target that is on the link
  over the link, and every other target through the Head. "Online apps" are
  the Head-online apps plus the linked apps. Apps on the link keep their
  subscription and features when the Head reconnects or reports `device_left`.
- **Routing (App)**: `sendEncryptedMessage` uses the link when the target
  Tentacle is linked. When the link comes up or goes down, the App calls
  `onTentacleUnavailable`, declares client features again and re-sends pending
  inputs. This is the same handling as a Tentacle rejoin.
- **Fallback**: when the link closes and the Head still sees the App, the
  Tentacle sends a new bootstrap through the Head, so the App subscribes again
  through the Head.

### Handshake (v1, JSON text frames)

```text
App → T   {type:"hello", v:1, appId, nonce:Na}
T → App   {type:"challenge", v:1, tentacleId, nonce:Nt,
           signature: sign_T("kraki-local-link/v1/tentacle\n" Na \n appId \n tentacleId)}
          (App verifies with the Tentacle key the Head registered.)
App → T   {type:"auth", signature: sign_A("kraki-local-link/v1/app\n" Nt \n tentacleId \n appId)}
          (Tentacle verifies with the App signing key the Head registered.)
T → App   {type:"ready", v:1}
then      {type:"pulse", pulse:<b64 frame>} both ways
```

- Mutual authentication uses the device keys the Head already registered. A
  loopback connection is not treated as an identity. The App drives the
  handshake as a strict state machine (`LocalLinkHandshake`): it signs only
  after the Tentacle's proof verifies, accepts `ready` only after sending its
  own proof, and fails closed on anything out of order (a bare `ready`, a
  second challenge, Pulse frames before `ready`, a wrong version).
- The signed strings are domain-separated. Head challenge auth signs a bare
  nonce, so neither side can be used to sign a Head challenge.
- Connections that carry a browser `Origin` are refused before the handshake.
- Only App devices of this account are accepted. `device_removed` closes the
  link.
- Discovery file: `<KRAKI_HOME>/local-link.json` (mode 0600) with
  `{v, port, tentacleId, pid}`. It is written after the first Head `auth_ok`
  and removed on shutdown. The App polls for it every 2 s while not linked.
- The listener binds `127.0.0.1` on a random port. Override the port with
  `KRAKI_LOCAL_LINK_PORT`. Disable the link with `KRAKI_LOCAL_LINK=0` on either
  side.

## Files

- `packages/tentacle/src/local-link.ts`: loopback server, handshake, per-peer Pulse
- `packages/tentacle/src/relay-client.ts`: routing, presence, bootstrap and fallback, counters
- `packages/arm/ios/Kraki/Core/Networking/LocalLinkClient.swift`: macOS client
- `AppState.swift` / `AuthManager.swift` / `MessageRouter.swift`: routing and transition hooks
- `MacAutomationDriver.swift`: `localLink` diagnostics in `snapshot`
- `MacApp.swift` (DEBUG only): starts the automation driver even when no window exists, for example on a locked screen
- `packages/tests/src/local-link-e2e.test.ts`: integration tests

## Verification (2026-10-10)

1. **Integration** (`pnpm --filter @kraki/tests test`, 59 + 4 new tests pass).
   The tests run a real Head, a real `RelayClient`, and an App connected both
   to the Head and to the link. They cover: handshake; bootstrap over the
   link; producer messages over the link with zero frames through the Head
   (`head.framesToLinkedApps === 0`); App→Tentacle subscribe and
   subscriber-only deltas over the link; fallback to the Head on link close;
   the link staying up while the Head socket drops; and rejection of unknown
   devices, forged signatures and browser origins.
2. **Real Mac App, isolated stack**. Setup: `pnpm dev` (local Head :4410 and a
   daemon under `.tmp/kraki-local`), plus the Debug `Kraki Dev.app` with
   `KRAKI_DEV_LOCAL=1`, driven headless through native automation. Results:
   - Link ready about 16 ms after Head auth. The agent list, usage and session
     list all arrived over the link.
   - Real Pi session (deepseek-flash): created, prompted, answered
     `LOCAL-LINK-OK`.
   - Tentacle counters: 13 payloads to the App over the link, **0 frames
     through the Head addressed to the linked App**. The only Head traffic was
     Pulse heartbeats/acks and the `@head` push-preview dispatch.
   - App counters: payloads in 3 → 13 and out 2 → 7 over the link. Head frames
     to the linked Tentacle stayed flat.
   - Daemon stopped: the App detected the dropped link at once and fell back.
     Daemon restarted on a new port: the App linked again by itself
     (`linkUps=2`). A second prompt in the same session got the answer
     `AFTER-RESTART-OK`, again with 0 Head frames to the linked App.
3. **Parity test** (`local-link-parity.test.ts`). The same deterministic
   script runs twice: once with the Mac App reaching this Mac's Tentacle
   through the Head, once over the local link. A phone (Head) and a second
   computer take part in both runs. Every message the Mac and the phone
   receive after bootstrap is normalised (device ids, timestamps, random ids)
   and must be identical in the two runs: 68 for the Mac, 61 for the phone,
   covering 25 message types. The flows covered are input and echo from both
   devices, streaming deltas, tool card, permission approve, question and
   answer, abort, mode/model/rename/pin/read, compaction, system notice,
   error, history ranges, Steps, paced attachment chunks (bulk stream), a
   1 MB reply, archive and the archived list, usage history, the other
   computer's session, and delete (durable). A deliberate mutation (dropping
   one payload on the link) makes the test fail, so the comparison really
   detects loss. Stable over repeated runs.
4. **Real Mac App, second run**: a pi session with bash tool calls, the
   reply arriving over the link, Steps for a fresh bubble fetched over the
   link (bulk stream), and abort of a running `sleep 60` (preview "Stopped").
   The Tentacle sent the linked App 25 payloads over the link and 0 frames
   through the Head.
5. Not covered yet: permission/question answered from the real Swift App
   (the parity test drives them from a simulated App), images and voice
   through the real App, Swift unit tests for `LocalLinkClient`, and
   Head-offline operation (not supported yet, see below).
6. iOS target builds unchanged. Tentacle `tsc` is clean. One existing flaky
   tentacle unit test (`cli.test.ts` hidden daemon worker) failed in a full
   parallel run and passes on its own.

## Adversarial round (2026-10-10)

Four real bugs were found and fixed:

1. **Head blip dropped the link's subscription (App).** A Head reconnect
   reset every subscription, including the one carried by the link, and
   nothing re-established it. Streaming text and the tool card froze until
   the link was rebuilt. Fix: `SessionSubscriptionController` keeps authority
   for Head-independent routes across a Head disconnect, and can drive them
   while the Head is down. Swift unit tests cover this; on the real App,
   `liveReady` now survives the blip.
2. **Subscribe during the 40 ms delta debounce duplicated draft text
   (Tentacle, pre-existing).** `card.state()` already held the buffered text,
   so it arrived once in the snapshot and again as the delayed delta. This
   also happens on the Head path. The link makes it frequent, because every
   route change resubscribes. Fix: flush the delta before taking the
   subscription or card snapshot. `subscribe-mid-stream.test.ts` reproduced
   3/20 rounds before the fix and 0/60 after.
3. **Stale Head frames after switching to the link (App).** Over a slow Head,
   deltas that were already in flight arrived after the link's snapshot and
   duplicated text. Fix: while linked to T, Head-delivered payloads from T are
   marked stale-route, and only `agent_message_delta`, `card_action` and
   `session_subscription_set` from them are dropped after decryption.
   `session_list` and spine messages still apply (`session_list` is the
   fallback barrier). Covered by a JS replay over a 250 ms proxy and a Swift
   unit test.
4. **A delayed Head-routed subscription overrode the link's (Tentacle).**
   Fix: drop `set_session_subscription` that arrives through the Head from an
   App that is on the link. Other commands still apply.

Also fixed: Swift skipped the sender check for reassembled fragmented
payloads (the reassembled payload lost the Head's `src`).

Further tests added in `local-link-tricky.test.ts`:
- exactly-once inputs while the link flaps and the App re-sends on both routes
- the phone is unaffected by flapping
- link replacement without a Head fallback in between
- an 8 MB upload over the link
- replayed auth signatures, impersonating the phone, garbage before the
  handshake, 50 idle connections, and injecting Head control or a spoofed
  deviceId over the link

Real App runs (headless automation): several long streaming replies with
Head blips and link drops in the middle (up to 8 per run), plus one run
through a 200 ms one-way latency proxy. Each time the final reply was
complete with no duplicates, and 0 card samples diverged from it.
Suites: Mac 146, iOS 447, integration 74, tentacle 1339, all pass.

Still not covered: sleep/wake on real hardware, production sign-in
(Keychain keys) and the built-in helper launch path, images and voice
through the real App, and long-running soak.

## Notifications (2026-10-10)

The Mac does not use APNs. The Tentacle sends an encrypted preview to the Head
(`dispatch_push`). The Head forwards it to online Macs that registered a
`local` token (`notification_preview`) and pushes it to offline phones.

**Problem with the link.** Messages reached a linked Mac over the link, but
notifications still came through the Head. If the Mac's Head connection was
down (Wi-Fi blip), the user saw the question or reply right away, and the
stale notifications then arrived in a batch when the network came back
(measured: about 15 s late, 3 at once).

**Design: two copies, deduplicated.**
- Every preview carries a random `nid` inside the encrypted plaintext.
- Besides the usual `dispatch_push`, the Tentacle sends each App on the link a
  `local_notification` (E2E encrypted, plaintext preview inside). The Head
  copy is unchanged; it covers a link that drops at the moment of the event.
- `MacNotifications.present` claims the `nid` before any other rule, so a
  copy suppressed because the Session was on screen also suppresses the other
  copy, even if that copy arrives after the user has moved on. Previews
  without an `nid` (older Tentacles) are never deduplicated.
- `NotificationDeduper` keeps the most recent 512 ids in UserDefaults, so a
  late Head copy is still recognised after the App restarts.
- Phones and other devices are unchanged.
- APNs size, worst case (1500-byte CJK summary, 80-character title): 3356
  bytes, 3296 without `nid`. The limit is 4096.

**Verification.**
- `local-link-notifications.test.ts` (5 tests):
  - Same notifications in Head and link modes, with matching ids.
  - Mac's Head connection down: notifications still arrive over the link.
  - Tentacle cut off from the Head for 8 s: notifications are on time over
    the link, and the late Head copies are all duplicates.
  - Link closed just before the event: the Head copy notifies, so nothing is
    lost.
  - An unlinked second Mac and the phone get nothing new.
- The parity test checks that the link mode receives exactly one
  `local_notification` per push dispatch.
- `MacNotificationDedupTests` (8 tests): both arrival orders, ids missing,
  suppressed while viewing, notifications disabled, restart persistence and
  capacity, malformed ids, and routing of `local_notification`.
- Real App, Head connection behind a 6 s one-way delay: the link copy was
  posted at 17:52:36.990, and the Head copy arrived at 17:52:42.967 and was
  dropped as a duplicate.
- Suites: Mac 154, iOS 447, integration 79, tentacle 1339, head 347.

## Independent review fixes (2026-10-10)

A separate GPT-6-Sol agent reviewed the change and tested it in its own
worktree (`review/local-link-gpt`, report `REVIEW-local-link.md`). It found:

- **P1:** the Mac linked on a bare `ready`, with no signatures checked. It
  reproduced this with a fake listener. **Fixed** with the
  `LocalLinkHandshake` state machine (6 unit tests). Re-run on the real App
  against the same fake listener: the App rejects it ("unexpected ready
  during awaitingChallenge"), stays on the Head, keeps its live
  subscription, and inputs reach the real Tentacle. The fake received 0 data
  frames.
- **P2:** an outgoing Tentacle deleted its successor's discovery file.
  **Fixed:** the record carries a random `instance` and is removed only if
  it is still this listener's.
- **P3:** shutdown left unauthenticated sockets open. **Fixed:** every
  accepted socket is tracked and closed.

Hardening done in the same pass:
- At most 16 unauthenticated connections; when full, the oldest is evicted,
  so squatters cannot lock the real App out.
- Frames over 4 KB are refused before the handshake completes.
- The discovery temp file has a random name and is created with O_EXCL.
- Subscription requests carry a `requestId` that the Tentacle echoes. An ACK
  from an earlier request to the same target, for example one still in
  flight on a replaced route, is ignored. Old Tentacles that echo nothing
  are matched the old way.
- When a link dies, the idempotent commands it accepted but never confirmed
  are re-sent through the Head: input, approve/deny/always-allow, settings,
  read state, archive, delete, kill. `create_session`, `fork_session` and
  connection-scoped commands are not. On the real App, input sent and the
  link dropped at once, 3 times: each was re-sent through the Head and ran
  exactly once.
- Test fixes from the review:
  - The parity test now compares delivery order per (sender, stream). A
    swap mutation is caught; swaps that only move a `local_notification`
    are deliberately not compared.
  - `subscribe-mid-stream` waits for the ACK correctly and applies `reset`.
    It still catches the original bug when the fix is reverted.

Suites after the fixes: integration 83, tentacle 1339, head 347, Mac 163,
iOS 449, all pass.

## Review round 2 fixes and acceptance runs (2026-10-11)

Round 2 (`REVIEW-local-link-round2.md` in the review worktree) confirmed the
round-1 fixes on the real App, including stronger forgeries: replayed
challenges, wrong id, a 5 MB frame, and a server that challenges but never
sends `ready`. It also found:

- **Queued replayable commands were lost on link loss.** A command waiting
  behind a paced fragment upload was not tracked. Latent today, because the
  link sends whole payloads with no pacing. **Fixed:** commands are tracked
  whole from `sendEncrypted` until every Pulse seq carrying them is ACKed,
  and are replayed whole, never as stray fragments. The reviewer's red test
  plus 2 new tests now pass.
- **A socket flood could evict an App mid-handshake.** **Fixed:** sockets
  that never said hello are evicted first. The new test fails on the old
  policy.
- **`mark_unread` replay could undo a newer read.** **Fixed:** it is removed
  from the replay set, since it is relative to the read cursor.

Real-App acceptance (headless Debug app, isolated stack):
- Permission approved in the App, link dropped at once: the approval was
  replayed through the Head (`replayedViaHead=1`) and the tool ran exactly
  once.
- `kill -9` of the daemon mid-turn: the stale discovery file is harmless.
  The App fell back to the Head and relinked to the restarted daemon. The
  killed turn shows "Turn failed", as it does without the link. The next turn
  worked normally.
- App quit mid-turn and relaunched: it linked again, and the 700-line reply
  was complete with no duplicates.
- 20-minute soak: 200 streaming turns with 165 random Head blips / link
  drops, 121 link re-establishments. Every input ran exactly once, and the
  App's copy matched the Tentacle's record in every turn. Three turns were
  flagged, all model behaviour: once deepseek repeated the list, twice it put
  the list in an intermediate message, which Kraki correctly shows as Steps.

Suites: integration 84, tentacle 1339, head 347, Mac 166, iOS 449.

## Attachments (2026-10-12)

Real-App checks, using a Debug-only `attachmentProbe` automation command:
- **Agent `show_image` (600 KB, 5 chunks) and `show_report` (167 KB HTML):**
  both fetched over the link. The SHA-256 of the bytes the App received
  matches the source files.
- **Link dropped mid-download:** 3 MB images (23 chunks), with 1 and with 3
  drops. Byte-exact every time. This found a bug: the chunk request in
  flight on the dead link was never answered, so the download stalled until
  the 30 s chunk timeout (31 s instead of under 1 s). **Fixed:**
  `AttachmentStore.routeChanged()` re-requests the in-flight chunk when the
  route switches. With the fix the same drop costs 2.3 s. Unit test added.
- **App → Tentacle image upload:** sent normally, and with the link dropped
  right after sending (re-sent through the Head). Each arrived exactly once
  and byte-exact in the Tentacle's record.

## Windows / Linux desktop app (2026-10-12)

The desktop shell (`packages/desktop`, Electron) runs the web client, which
now has the same local link (`packages/arm/web/src/lib/local-link.ts`).

- **Discovery:** the shell's main process reads `<KRAKI_HOME>/local-link.json`
  (at most 4 KB) and hands it to the page over IPC (`localLinkDiscovery`).
- **Origin:** the page connects from `app://kraki`. The Tentacle accepts no
  Origin (native clients) or exactly `app://kraki`, which no web page can
  claim. Every other origin is still refused before the handshake.
- **Listener:** the Tentacle now listens on every platform (it was macOS
  only), unless `KRAKI_LOCAL_LINK=0`. On Windows the discovery file is
  replaced with a retried rename, since a reader briefly holding the file
  open makes a rename fail.
- **Behaviour, same as the Mac App:**
  - Strict handshake state machine.
  - Commands for the linked Tentacle go over the link.
  - Head frames from the linked Tentacle drop their live state (deltas,
    card, subscription ACKs).
  - A linked Tentacle's subscription survives Head blips; a Head
    `device_left`/`device_joined` for it changes nothing.
  - On link loss, unconfirmed idempotent commands are re-sent through the
    Head, and the in-flight attachment chunk is re-requested.
  - Retries back off from 2 s to 60 s.
  - Desktop notifications come from the live messages, so they arrive on
    time over the link with no extra dedup.
- **Fork parity (#455):** the requesting device seeds the fork's history from
  its cached copy of the source, as on Mac/iOS (`message-db.seedFork`).

Verification:
- `local-link-desktop.test.ts` runs the real web `LocalLinkClient` against a
  real Head and Tentacle in Node: link from `app://kraki`, both directions,
  0 Head frames for it, browser origin refused, a fake `ready`-only server
  never trusted, replay hand-off on drop. Mutations caught: a bare `ready`
  accepted, and the desktop origin refused.
- Web unit tests: subscription request ids and independent routes;
  `ws-client` routing, stale-frame drop, `device_left`, replay; `seedFork`.
- **Real desktop shell (Electron, run on macOS with an isolated data dir,
  hidden window, driven over CDP):** paired through the Head, linked from
  `app://kraki`. A message typed in the composer and its reply both went over
  the link, with 0 Tentacle frames for this App through the Head. After a
  daemon restart it relinked by itself and the next message worked the same
  way. Each message ran exactly once in the Tentacle's record.
- **Not yet run on real Windows** (the Windows PC was unreachable).

## Known gaps / next steps

- **No offline mode yet.** The Tentacle already serves linked Apps while its
  Head socket is down. The App, however, starts the link only after Head auth
  (it needs the device list to verify keys) and gates subscriptions and sends
  on `connectionStatus == .connected`. For Head-down use, cache the local
  Tentacle's key and relax those gates for the linked Tentacle.
- **Switch-over races.** Frames already queued on the Head Pulse before the
  switch can still arrive after it. In the real run, 2–3 retransmits counted
  in `headFramesToLinked`. They are harmless: inputs are idempotent and
  `session_list` re-establishes authority. A stale `set_session_subscription`
  sent through the Head can still overwrite the link's subscription
  (`currentSessionByArm` is keyed by device, not by transport). Fix this by
  tagging the subscription with its transport, or by ignoring Head-routed
  commands from linked Apps.
- **Discovery** finds one Tentacle per `KRAKI_HOME`. The file is polled, not
  watched.
- **Productisation**: a UI indicator ("Local" next to This Mac), metrics, a
  protocol version negotiation story, and a security review of the loopback
  listener. The listener allows only authenticated peers, but any local
  process can open connections to it, which is a DoS surface.
- The POC counters (`headTx`, `headFramesToLinked`) are diagnostics only.
