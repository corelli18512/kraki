# Native session preview status glyphs

Scope: iOS/macOS **session-list preview rows only**. No new composer or chat-bubble glyph, no wire protocol change.

## Approved designs

- Delivery: option B, native SF `tray.and.arrow.up`, 11.5 pt medium, centered in the existing 16 pt slot. Correcting uses a 1.8 s opacity breath (0.52–0.80); sending a 1.3 s breath (0.78–1.00) and up to 0.65 pt upward travel. Failed is the same red/static symbol; queued is gray/static.
- Compacting: shared B3 rounded plane with only the front rims on lower layers. Rim endpoints align with the rounded top's actual bounds, not the original sharp tips. Whole geometry/stroke/travel is centered at 98%; outer layout remains 16 pt. B3's 2 s cycle is 640 ms press, 560 ms hold, 260 ms release, 180 ms settle, 360 ms rest. The 0.28 pt overshoot per outer layer is scaled to 0.2744 pt. Lower-rim alignment and the top's 12.5×6 pt / 0.85 pt rounded geometry are retained.

## Projection and ownership

`SessionPendingPreview` chooses the most recent failed input, otherwise the most recent pending input. Local order wins over timestamps; ties have a deterministic client-ID fallback. The selected text, time and icon are projected as one unit, ahead of a different draft or server preview. Backend session state/unread counters are not changed by this overlay.

- `correcting` appears only for explicitly sent/staged voice input. Editing/correcting an unsent draft does not create delivery status.
- `sending` means awaiting the Tentacle's `user_message` echo, not merely WebSocket acceptance. Loss of relay/target connectivity projects it as queued without marking it failed. Local correction and existing failure retain their states offline.
- Failed/queued previews have a short textual prefix in addition to color. The row's accessibility label includes the delivery phase and content. A row tap retains the original navigation behavior, never automatically retries.
- Confirmation clears only the matching client ID. Once no input remains, projection reveals the current runtime/preview/draft status rather than hard-coding a human icon.
- Historical/range `user_message` echoes also confirm the same ID. Explicitly mismatched sessions and non-user messages never confirm. A row missing its own session ID inherits the authoritative batch envelope. Restoring the durable outbox checks the SQLite cache once per restored input, so an already confirmed send does not surface as a false failed row even when chat history has never been opened. There are no new SQL reads on the list's rendering path.

The iOS diffable fingerprint includes the projected delivery text/state/time. SwiftUI card bodies observe the outbox and connection state directly. Correction content changes do not restart the glyph's animation.

## Animation lifecycle

`SessionPreviewGlyphLayer` owns persistent Core Animation layers. It animates opacity/translation, never per-frame SwiftUI state, layout, view IDs, or recurring symbol-effect identity resets. Color/backing-scale updates preserve layer identities and animation start times.

The native host reconciles visibility on layout/window changes and at 4 Hz **only for attached, enabled, animated kinds**; this is a visibility check, not the animation driver. Hidden, clipped, outside-window, detached, background, and Reduce Motion states stop animation; visible/reused hosts reinstall it. Timers hold a weak reference and are invalidated on disable/detachment/deinit. Failed/queued kinds need no visibility timer. An explicit window-bounds intersection covers AppKit views whose `visibleRect` can remain nonempty outside an unclipped parent.

## Regression coverage

`SessionPreviewGlyphTests` is compiled into both KrakiTests and KrakiMacTests. It covers:

- atomic optimistic text/icon projection, draft/correction distinction, multiple pending/failed records, stable ordering, offline/online, attachment-only text and restoration of runtime state;
- real CommandSender stage/correction/failure/retry/dispatch/duplicate-late-ACK sequences;
- history/range confirmation, foreign-session/type fencing, cached confirmed messages during durable restoration;
- B3 bounds/overshoot, aligned lower paths, 98% stroke, loop endpoints and timing;
- layer identity/phase across theme/display changes and animation cleanup/reuse;
- actual native host hide/offscreen/detach/reattach/static lifecycle;
- **real production session-row observation** through iOS SessionTable/UIHostingConfiguration and macOS MacSidebarSessionRow, without manually reconfiguring between outbox/connection transitions;
- iOS fingerprint changes for phase, correction text and connectivity.

Run:

```sh
cd packages/arm/ios
xcodebuild -project Kraki.xcodeproj -scheme Kraki -destination 'platform=iOS Simulator,id=<isolated simulator>' \
  CODE_SIGNING_ALLOWED=NO test -only-testing:KrakiTests/SessionPreviewGlyphTests
xcodebuild -project Kraki.xcodeproj -scheme KrakiMacTests -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO test -only-testing:KrakiMacTests/SessionPreviewGlyphTests
```

Mac tests use the existing isolated scenario-host scheme; do not launch or replace the user's production app. The host-lifecycle unit test controls NSWindow's occlusion input (and explicitly toggles visible/occluded) so screen lock or the human's active Space cannot invalidate the fixture; native attachment, bounds and clipping remain real. The production-row observation test uses an ordinary NSWindow. iOS SwiftUI-host tests attach their test window to a real simulator UIWindowScene (a frameless scene-less window cannot validate SwiftUI rendering).

An independent local design-parity harness compares 20,001 curve samples with the approved B3 study and rasterizes every aligned path at 2×/3×/8× after centered98% transformation; byte-identical images are required. This is geometry/motion parity, not a claim of constant 60/120 fps. Native recordings or a 60 fps export are not production-list performance benchmarks.
