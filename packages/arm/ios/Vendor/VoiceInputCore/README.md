# VoiceInputCore

Reusable Apple-platform client engine for an `@coinfra/voice` gateway.

It captures microphone audio with `AVAudioEngine`, converts the first channel to
mono Int16 PCM, buffers audio until the gateway is ready, and emits protocol
facts as host-owned events. It has no UI, global hotkey, pasteboard,
Accessibility, product account or payment assumptions.

## Add to another app

For a local checkout:

```swift
// Package.swift
.package(path: "../voicetype/Packages/VoiceInputCore")
```

Then depend on the product:

```swift
.product(name: "VoiceInputCore", package: "VoiceInputCore")
```

## API

```swift
import VoiceInputCore

let session = VoiceInputSession(
    configuration: VoiceInputConfiguration(
        gatewayURL: gatewayURL,
        apiKey: shortLivedCredential,
        userID: userID,
        correctionEnabled: true,
        context: [
            "inputMethod": .string("dictation"),
            "product": .string("kraki"),
        ],
        vocabulary: vocabulary,
        authorizationFields: [
            "deviceId": .string(deviceID),
            "authorization": nestedLease,
        ],
        startFields: ["sampleRate": .number(16_000)]
    ),
    onEvent: { event in
        switch event {
        case .connectionAuthorized:            break
        case .gatewayReady:                    break
        case .level(let peak):                 meter.update(peak)
        case .partial(let raw):                view.showRaw(raw)
        case .correctionDelta(let display):    view.showCorrection(display)
        case .final(let text, let rawText):     accept(text, rawText)
        case .failed(let reason):              fail(reason)
        }
    }
)

session.startCapture(context: [:], vocabulary: []) // after permission/audio-session activation
session.stopCapture() // finish audio, wait for authoritative final
session.close()       // cancel/tear down
```

`correctionDelta` is display-only. Only `final` is authoritative.

## Host responsibilities

- request microphone permission and activate the iOS audio session before `startCapture` (constructing a warm connection never opens the microphone);
- provide authentication and opaque context;
- retain the session strongly until final/failure/cancellation;
- decide how to render partials and correction;
- decide whether/how to paste or insert final text;
- own account, plans, quota and payment behavior.

## Reliability and diagnostics

Mac and iOS use the same implementation. Capture lifecycle, WebSocket writes/receives
and watchdogs run on one serial worker, not the UI queue. Host events/metrics are
asynchronously delivered on the main queue. `stopCapture` enqueues ordered EOF;
`close` is a synchronous teardown barrier so the host may safely deactivate the
iOS audio session or start a replacement recording after it returns.

- A missing PCM callback for 3 seconds fails capture. Silence still produces PCM
  and is **not** a failure. Runtime device/format changes fail visibly; they do not
  silently restart and discard part of an utterance.
- An individual write has a 5-second deadline, and pending audio is bounded to
  384,000 bytes. A single ordered writer puts `finish` after accepted audio.
- Each recording has a random `recordingId`; late capture callbacks and tagged
  broker frames from previous recordings cannot mutate the next recording.
- New brokers add `closed.finalReceived`: `false` means missing-final failure,
  `true` means ASR finished but correction may still be pending. Legacy brokers
  without that field remain supported; a missing final is diagnosed at the
  bounded final deadline rather than mistaking all ASR closes for failures.
- `log` receives only low-frequency lifecycle tags, random correlation IDs,
  numeric error codes and byte/age counters. It never receives transcripts,
  provider messages, URLs, context or credentials. Hosts can safely keep this
  channel on in Release. The `.failed` event is separate: its reason is for
  product error handling and must not be blindly persisted.

The host must preserve already received raw text on failure and must not mark a
partial transcript as a successfully completed/sendable utterance.

## Test

```bash
swift test --package-path Packages/VoiceInputCore
```
