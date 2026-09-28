# iPhone composer and tap-to-dictate

Design reference: `ReleaseArtifacts/Kraki/ios-composer-layout/V5-FLOW.html`.
The layout below describes iPhone. macOS keeps its compact native composer,
but now shares the `IOSVoiceComposer` transaction (historical name) for
recording / draft editing / optimistic bubble correction. Session mode is
chosen in the chat header; the composer has no mode strip or swipe.

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
dimmed speech at the caret) above `[Cancel] level time … [Edit]`, with the
send circle beside the capsule.

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
  receives corrected text. A free-form answer to a pending question goes the
  same way (the staged message carries `answerTo`). Only a permission deny
  reason behaves like Edit (reviewed in the field).
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
(`sending` → echo, or `failed` → Retry/Delete). `failStagedInput` marks it
`failed` with the original transcript (Retry sends it): **an unconfirmed
correction is never sent automatically**.

While correcting, words the correction has not reached are light and
corrected words solid (like the old composer); nothing else dims. Sent but not
delivered dims the whole message (text bubble and its image) after 0.8 s (no
flash on fast confirmation); delivered fades back, failed is shown normally with its "!". The status icon sits beside
the message's last block (the image when present).

A sent message is never edited. While correcting, the waveform status
offers *Send Original* (don't wait), *Edit* and *Delete*; a failed bubble offers
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

## macOS parity

`MacChatComposer` uses the same AppState-owned transaction, rather than waiting
for `onFinal` to fill a draft. While recording the primary control sends voice
including free-form answers through main PR #317's `answerTo` path. Only
permission denial returns to the editor for review. Recording Send never
aborts the agent. Cancel and Edit remain inside the capsule, bottom-aligned.
Send immediately frees the editor and stages a bubble; typed follow-ups can be
composed but cannot overtake the correcting message. The mic shows progress.

Mac bubbles show a waveform menu and light uncorrected text; render signatures
include the uncorrected range, even when a correction does not change letters.
Send Original uses the latest raw transcript, including trailing recognition.
Edit restores original text and image bytes/MIME in the mounted composer before
removing the bubble; if its image conflicts with an existing attachment, or is
invalid, the bubble stays intact. Delete/Send Original/Edit fence late results.
Native caret/selection restoration follows the utterance; real typing or caret
interaction takes over from a late draft correction. Session departure preserves
the original owner. Mac does not adopt iOS's app-inactive recording policy.

Mac uses a compact recording surface: disabled image icon or
existing thumbnail on the left, read-only transcript in the middle, labeled
Cancel and Edit on the right. No mic icon is shown while recording. The
separate primary circle remains Send. A low-opacity waveform fills only the
middle transcript area, excluding the image slot and Cancel/Edit controls.
Both horizontal edges fade to transparent over 12% of its width. Interpolated
microphone levels drive its spring animation (using iPhone's shared dB loudness
mapping, not a canned animation). The background does not participate in
layout or hit testing. The single-line capsule and primary/jump circles are
36 pt. Both typed and voice text expand upward to a three-line cap (36 / 54 /
72 pt for the tested 15 pt font), then scroll inside their viewport. The same
8 pt vertical padding stays OUTSIDE the viewport, including during overflow;
TextKit additionally retains its 1 pt caret inset on every line. Image and
Cancel/Edit controls stay at the bottom row. Short transcripts remain centered.
iPhone retains its two-row layout, compact meter and timer.

Mac's start cue is the user-selected original D1 warm single tone: 520 Hz,
150 ms designed sound plus 52 ms silence, packaged as `VoiceStartCue` in the
asset catalog. The WAV is byte-identical to the approved audition (SHA-256
`d16a5be4e7390c40225bd3024462212dfa26cd24a07080014f14c6794b6a3f9e`).
It replaces Hero; an unavailable cue now fails silently rather than beeping.
The cue still indicates the start action, not a guarantee that capture is ready.
iOS has no new start sound.

The current work includes main through `5116a9e` (including PR #324). iOS's already-fixed
free-form answer behavior is preserved, not reimplemented. A Mac native test
checks question ID on both the correcting bubble and the final transport
payload, with no steer flag even when the agent is active.

`KrakiMacTests` also runs all 28 shared transaction tests. Its thirteen
`MacVoiceComposerTests` use the production chat in an isolated native window,
real mouse events and native bubble menus, with synthetic speech/captured
transport. They cover recording send, steer, cancel, edit/caret, latest-original
send/delete, image restoration, ordered follow-ups, disabled recording
thumbnails, free-form voice answers, and real level-event updates without
moving the centered text or intercepting controls. They also verify exact D1
asset bytes/playability, single-row size stability, and actual viewport/text
padding for one/two/three lines, trailing newline, natural wrapping and overflow.
Screenshots are not a
physical microphone or live-network acceptance test.

## Physical acceptance before publication

Real microphone permission/interruptions/route changes; Chinese IME and
selection handles with Edit; background during correction; real gateway
correction, fallback and timeouts; VoiceOver / Switch Control / Dynamic Type;
small and landscape iPhones; image + dictation; running agent Stop ↔ Send.
