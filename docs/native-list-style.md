# Native list style

Scope: iOS/macOS session preview metadata and the main Session/Chat vertical scroll indicators. No change to chat anchors, pagination, follow-tail, editor/table/image scrolling, or system-wide preferences.

## Metadata

`SessionCardMetadataRow` and `SessionMetadataLayout` share width allocation between platforms. Device name and authoritative thinking level are measured first. Model gets the remaining width with SwiftUI `.truncationMode(.head)`; the model identifier in data remains untouched.

Ordinary rows stay one line. When a long device name plus effort would leave less than a useful model suffix, the device moves above model/effort and can wrap fully. Metadata has a minimum, not fixed, row height. An extremely narrow proposal can move effort onto a separate line. No whole-card scale-down or clipping is used. Platform fonts/colors/online dot are retained.

## Transient indicators

`TransientScrollIndicatorVisibility` is the shared visibility state machine, independent of scrolling policy:

- Remain visible while dragging, decelerating, smoothing a discrete wheel, tracking the Mac knob, or hovering the Mac scroller.
- Once **all** activity ends, wait 1.2 s, then fade for 0.3 s. Reduce Motion retains the idle delay but omits the fade.
- New interaction cancels old work and interrupts a fade. Reset/detach/page disappearance cancels pending hides.
- Content/viewport/inset changes only adjust thumb geometry; programmatic layout/streaming updates do not reveal it.

On iOS, only `SessionTableController` and `ChatPerfListVC` opt into `IOSTransientScrollIndicator`. The passive, non-accessibility sibling overlay cannot intercept list touches. Native indicators remain off; no private UIKit classes, fade-duration hacks or repeated flashes. Content inset participates in range calculation; safe area and indicator insets bound the track. No display link, per-frame SwiftUI state, cell enumeration or additional content layout.

On Mac, `MacTransientOverlayScrollerController` uses the same timing. `MacTransientScroller` retains NSScroller's tracking, target/action and accessibility, but paints the knob itself so AppKit's independent overlay flash/fade clock cannot hide it early. `wantsUpdateLayer` is disabled so the custom drawing actually runs, and value/proportion/appearance changes invalidate it. The existing legacy-gutter width repair remains intact. The actual chat knob still delivers its pagination/viewport callbacks. Wheel smoothing separately holds visibility until the last glide frame, not merely the last wheel event.

## Regression checks

`NativeStyleTests` runs on both native targets: deterministic scheduling/cancellation, overlapping activities, range clamping, non-scrollable content, actual SwiftUI metadata measurement, long device/long model/Dynamic Type, iOS inset geometry and passive hit behavior, and Mac scroller replacement/tracking/overlay width. `SessionPreviewGlyphTests` verifies common third-revision icon metrics and animation bounds/identity/reuse. Full runtime scenarios remain separate from pure policy tests.
