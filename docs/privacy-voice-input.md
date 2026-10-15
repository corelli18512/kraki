# Voice input: privacy policy and App Store checklist

Public policy: https://app.kraki.chat/privacy/ (source:
`packages/arm/web/public/privacy/index.html`). Keep it synchronized with client and
production gateway behavior. This is an engineering description, not a legal
opinion or a claim that provider categories alone satisfy every jurisdiction.

## Verified data flow (2026-10-15)

The hosted gateway currently uses Doubao / Volcengine (ByteDance) ASR and DeepSeek
correction. Confirm deployment configuration before changing provider claims.

| Recipient | Data |
|---|---|
| Kraki relay/account service | Account/device identity, signed voice leases, daily audio seconds; no voice recordings in the usage DB |
| Kraki voice gateway | Audio, transcript, authorization/account/device and recording identifiers; locale, Custom Words, and enabled conversation context |
| Speech provider | Audio, audio/model configuration and supplied recognition-user identifier |
| Correction model, when enabled | Transcript, Custom Words, locale; enabled session title, agent/model/mode and extracted terms |

Current gateway removes `product`, `sessionId` and `inputMethod` from the correction
model's prompt. The gateway itself can still see them. New-session terms can
include the selected computer name. Existing-session context extracts up to 32
terms from the most recent 12 messages rather than uploading whole messages.

**Correction off is not context off.** Clients can send vocabulary/context to the
gateway even when AI correction is disabled. `Use Conversation Context` off omits
session metadata/terms; locale and user-entered Custom Words remain. Neither option
turns cloud recognition into on-device or end-to-end encrypted recognition.

Context secret filtering is heuristic. It filters recognized token/credential,
URL/path and similar patterns; it cannot guarantee removal of every sensitive
value. Dictated text and user-entered vocabulary are not a guaranteed redaction
pipeline. Do not promise otherwise in public copy.

The inspected hosted gateway does not intentionally write an audio/transcript
archive; audio/text is processed in memory. It logs operational categories,
timings and usage. Final text can become part of local conversation history.
Third-party retention/training terms have not been independently established:
**do not promise zero retention or no training on a provider's behalf**.

## Controls and disclosure

- Before first dictation, the client explains that voice input uses cloud services.
- Correction and conversation context default on in supported clients.
- Settings → Voice Input controls both switches and Custom Words.
- Microphone permission and choosing not to dictate control whether to record.
- Custom Words are readable account preferences synchronized over TLS, **not E2E**.
- Optional performance diagnostics are a separate feature; voice summaries contain
  metadata, not audio/transcripts. Disabling diagnostics does not disable voice.

Technical references: `docs/security.md`,
`Kraki/Core/Speech/{VoiceProtocol.swift,VoiceVocabulary.swift}`,
`packages/arm/web/src/lib/voice/{context.ts,voice.ts}`, and
`packages/voice-broker/deploy/coinfra-lease-serve.mjs`. Inspect the deployed Coinfra
bundle/provider settings too; source defaults alone are not proof of production.

## App Store label checklist

Review the actual build and current questionnaire before submission. Relevant
categories to consider under **Data Linked to You**, not tracking:

| Data type | Purpose | Notes |
|---|---|---|
| User Content → Audio Data | App Functionality | Dictation, cloud processing |
| User Content → Other User Content | App Functionality | Transcript, Custom Words, limited correction context |
| Usage Data → Product Interaction | App Functionality | Daily per-account voice seconds for quota |
| Identifiers → User ID / Device ID | App Functionality | Account-authorized voice and device identity |

Apple's questionnaire distinguishes transient processing from collection; verify
provider processing/retention rather than infer label exemptions from gateway
memory-only behavior. The public policy must still explain the actual data flow.

## Purpose strings

`NSMicrophoneUsageDescription` already says the app sends recordings to its cloud
speech service to turn them into text. That does not substitute for the fuller
policy, provider disclosures or applicable consent requirements.
