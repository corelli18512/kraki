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
        startFields: [
            "deviceId": .string(deviceID),
            "sampleRate": .number(16_000),
            "lease": nestedLease,
        ]
    ),
    onEvent: { event in
        switch event {
        case .gatewayReady:                    break
        case .level(let peak):                 meter.update(peak)
        case .partial(let raw):                view.showRaw(raw)
        case .correctionDelta(let display):    view.showCorrection(display)
        case .final(let text, let rawText):     accept(text, rawText)
        case .failed(let reason):              fail(reason)
        }
    }
)

session.stopCapture() // finish audio, wait for authoritative final
session.close()       // cancel/tear down
```

`correctionDelta` is display-only. Only `final` is authoritative.

## Host responsibilities

- request microphone permission before constructing a session;
- provide authentication and opaque context;
- retain the session strongly until final/failure/cancellation;
- decide how to render partials and correction;
- decide whether/how to paste or insert final text;
- own account, plans, quota and payment behavior.

## Test

```bash
swift test --package-path Packages/VoiceInputCore
```
