# iPhone composer and tap-to-dictate

Design reference: `ReleaseArtifacts/Kraki/ios-composer-layout/V5-FLOW.html`.
iPhone only. macOS keeps its own composer and the controller's `onFinal`
draft behavior. Session mode is chosen in the chat header; the composer has
no mode strip or swipe.

## Layout

One glass capsule, 48 pt for a single line, growing upward to 5 lines:
`[image | thumbnail] text [ⓧ] [mic]`, and the primary button outside it: a
44 pt circle in the same trailing column and 8 pt spacing as the chat's jump
controls, staying on the capsule's last line. One circle morphs between
Send (grey/active), Stop and dictation Send (fill + symbol replace).

- **Image**: single image. Once chosen, the attach icon becomes its thumbnail
  (tap to replace, small × to remove).
- **ⓧ**: shown when there is text or an image, vertically centered; clears
  both (no undo).
- **Primary**: Send (grey when there is nothing to send). While the agent runs
  and nothing is typed it is **Stop**; typing turns it into Send (steer) in
  place, clearing turns it back. With a pending question/permission, Send
  answers / denies with reason.
- A tap anywhere in the text area focuses the field. Body text follows Dynamic
  Type. All buttons keep ≥ 44 pt touch targets.

## Dictation

Tap the mic: the keyboard is dismissed and the capsule expands in place into
two rows — a read-only live transcript (existing draft shown around the new,
dimmed speech at the caret) above `[Cancel] level time … [Edit] [↑]`.

- **Cancel**: discard the utterance. The draft was never touched while
  recording, so nothing needs restoring.
- **Edit**: collapse at once; the raw utterance is inserted at the caret
  (replacing a selection) in the real field, which is focused. The correction
  replaces only that utterance, and only if the user has not typed, moved the
  caret or refocused (draft revision + content fence, ABA-safe).
- **↑ Send** (prompt / steer): collapse and clear at once. The whole message
  (draft with the utterance inserted, plus image) appears immediately as an
  optimistic bubble in state `correcting`; the correction is applied over the
  transcript in place (corrected so far + not-yet-corrected rest, so no words
  vanish and the bubble never shrinks while correcting); it
  is **transmitted only when the correction completes**, so the agent always
  receives corrected text. With a pending question/permission, ↑ behaves like
  Edit (structured replies are reviewed in the field).
- Latin words get one separating space; CJK, whitespace and punctuation don't.
- Leaving the conversation or the app becoming inactive while recording turns
  the speech into that conversation's draft (no focus, never sent). A staged
  send continues at its origin. Backgrounding closes the voice socket: a staged
  message becomes *not delivered* with its original transcript.
- While a sent voice message is correcting, the mic shows progress and typed
  sends wait, so messages reach the agent in order.

## Sent-but-correcting bubbles (`CommandSender`)

`stageInput` adds a `pending_input` with `localState = correcting` and
`originalText`; nothing is sent. `updateStagedInput` streams text in place
(the list re-measures the row). `dispatchStagedInput` transmits exactly once
with the same clientId and then follows the normal optimistic path
(`sending` → echo, or `failed` → Retry/Edit/Delete). `failStagedInput` marks it
`failed` with the original transcript (Retry sends it): **an unconfirmed
correction is never sent automatically**.

While correcting, words the correction has not reached are light and
corrected words solid (like the old composer); nothing else dims. Sent but not
delivered dims the whole message (text bubble and its image) after 0.8 s (no
flash on fast confirmation); delivered fades back, failed is shown normally with its "!". The status icon sits beside
the message's last block (the image when present).

A sent message is never edited. While correcting, the waveform status
offers *Send Original* (don't wait) and *Delete*; a failed bubble offers
*Retry* and *Delete*. A user action wins; the late correction then no-ops. A correcting input persisted across process death is
restored as `failed` with its original transcript.

### Correction confirmation

The gateway can silently forward raw ASR as the final after a corrector error,
so a final alone is not proof. A result counts as corrected only with the
gateway's nonempty `rawText` provenance, or a complete correction stream
(trimmed) equal to the trimmed final. Otherwise the bubble fails to the
original. An identical full stream followed by an error cannot be told apart
from success, but then the transmitted text equals what was streamed.

## Speech controller notes (shared with macOS)

`KrakiVoiceInputController.begin` is `@MainActor` (Swift 5 mode would run a
nonisolated async method on the global executor and race cancel/finish); an
audio activation superseded by cancel is deactivated. `onRaw`,
`onCorrection` and `onCompletion` are opt-in; `onFinal` clients are unchanged.
Permission/lease completion after cancel is generation-fenced and cannot open
the microphone.

## Isolated gates

```sh
KRAKI_TEST_SIMULATOR=<dedicated-simulator-uuid> \
KRAKI_SOURCE_PACKAGES_DIR=<optional-cached-SourcePackages-directory> \
  scripts/ios-voice-hold-gate.sh
```

Independent `chat.kraki.design.hold-c*` bundles, temporary project/HOME, a
synthetic voice engine and captured transport; nothing is sent anywhere and
`/Applications/Kraki.app` is never touched. Release builds exclude the
scenario. `KrakiTests/IOSVoiceComposerTests.swift` (transactions, races,
controller safety) and the voice section of `ChatUXRegressionTests.swift`
(real outbox + list: correcting bubble, exact row height, exactly-once send,
failure → original, relaunch). `KrakiVoiceUITests` drives the real composer.

## Physical acceptance before publication

Real microphone permission/interruptions/route changes; Chinese IME and
selection handles with Edit; background during correction; real gateway
correction, fallback and timeouts; VoiceOver / Switch Control / Dynamic Type;
small and landscape iPhones; image + dictation; running agent Stop ↔ Send.
