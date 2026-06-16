# @kraki/arm-ios

Kraki native iOS app — the iOS receiver.

Implemented as a native Swift / SwiftUI app targeting iOS 18+. Mirrors
the web client's functionality (sessions, devices, settings, push) over
the same encrypted relay transport, with on-device speech-to-text and
APNs push (via a Notification Service Extension for decrypted previews).

Source layout:

- `Kraki/App` — entry point, `AppState`, scene hookup.
- `Kraki/Core/Networking` — `WebSocketClient`, `AuthManager`,
  `EncryptionHandler`, `MessageRouter`, `PushManager`,
  `PreferencesManager`.
- `Kraki/Core/Storage` — `SessionStore`, `MessageStore`, `DeviceStore`,
  `CommandSender`, `MessageProvider`, on-disk caches.
- `Kraki/Core/Crypto` — `KeychainManager`, `CryptoManager`.
- `Kraki/Core/Speech` — `SpeechRecognizer` (on-device dictation).
- `Kraki/Features/*` — Auth, Chat, Sessions, Devices, Settings, Actions.
- `KrakiNotification/` — Notification Service Extension that decrypts
  push previews using the same crypto material as the main app via the
  shared `group.chat.kraki.ios` App Group.

Project files:

- `Kraki.xcodeproj` — generated from `project.yml` via [xcodegen](https://github.com/yonsm/xcodegen).
- `Package.swift` — SwiftPM manifest used for unit-test execution.
- `Kraki.entitlements` / `Kraki.Release.entitlements` — Debug uses the
  `development` APNs environment and `?mode=developer` associated
  domains; Release uses `production` APNs and the bare domain.

