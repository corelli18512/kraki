# Shared Apple voice reliability

Mac and iOS both consume `packages/arm/ios/Vendor/VoiceInputCore` and the shared
`Kraki/Core/Speech/KrakiVoiceInputController.swift`. The fix is one native-client
change, not separate Mac/iPhone implementations.

## Failure handling

The transport state machine, audio ingress, ordered WebSocket writer and timers
run on a serial worker. Only host events and metrics return to the main queue.
The recording fails safely when capture produces no PCM for 3 seconds, the input
configuration changes, conversion fails, upload stalls for 5 seconds or its
384,000-byte audio buffer fills. Silence is not missing PCM. Capture is not
silently restarted: the host retains received raw text as an incomplete draft,
never auto-sends it as a successful voice result.

ASR closure is not synonymous with completed correction. Updated gateways send
`closed.finalReceived=false` for missing-final failures, or `true` when the ASR
final has arrived and correction may still be pending. The client remains
compatible with old gateways lacking this field, retaining the bounded final
wait and preserving normal correction. Random recording UUIDs fence stale tagged
wire events and old capture callbacks; they are not account/session IDs.

The gateway implementation actually deployed by the product is **@coinfra/voice
in the coinfra repository**, not the old implementation under
`packages/voice-broker/src`. Its terminal/auth-race fix is a companion upstream PR.
No unpublished package version is pinned here; client-only capture/upload fixes
work with the existing gateway. Deploy the upstream release separately to obtain
explicit missing-final handling for old clients as well. Neither PR implies a
production deployment.

## Release diagnostics

`LiveVoiceInputSessionFactory` forwards the core's metadata-only lifecycle log to
`KLog.diag`, not the Debug-only logger. The low-frequency records include:

- random connection/recording IDs;
- a fixed stage/failure tag and numeric provider/transport error code;
- captured, sent and buffered bytes and the age of the last PCM callback.

No PCM, transcript, context, endpoint URL, provider error body or credential is
logged. The raw failure event is still classified into user-facing errors; do not
persist it unfiltered. On macOS use Console / Unified Log, filtering process
`Kraki` and `[voice-core]`. On iOS collect the app's device log in Console. The
same random recording UUID can correlate a new broker's log.

## Validation

Hardware-free SwiftPM tests exercise the production state machine with injected
transport/capture boundaries, including send backpressure and ordering, capture
stall vs silence, interruption, invalid buffers, explicit and legacy ASR closes,
warm reuse, cancellation, late callbacks and log privacy. Existing controller
and composer suites cover preservation of drafts and send intent on both Apple
platforms. Upstream has local WebSocket/ASR fault-injection tests for terminal
handling and authorization races.

Real microphone/device switching and network-loss acceptance still requires a
separate physical-device session. These fixes address confirmed code defects;
they do not prove the trigger of the single 2026-10-04 timeout incident.
