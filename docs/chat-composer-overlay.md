# Native chat composer clearance

Applies to iOS and macOS. Keep the production composer, glass material, controls,
recording animation and bottom placement. The expanding surface is an overlay,
not a reason to re-pin the conversation: it only extends how far the list can
scroll, so the bubbles it covers can be revealed by hand.

## Spacing contract

At the newest edge with a resting one-line composer:

| Platform | Last bubble → capsule | Capsule → available bottom edge |
| --- | ---: | ---: |
| iOS | 12pt (= bubble → bubble) | 6pt, **excluding** the home-indicator safe area |
| macOS | 12pt (= bubble → bubble) | 12pt |

The last bubble rests above the capsule at the same distance as two bubbles
rest from each other (each cell pads 6pt above and below its bubble).

The system safe area is additional, not part of the matching visual spacing.
Do not move the iOS capsule down into the home-indicator area. Short conversations
remain top-aligned; this rule must not stretch empty history to fill the screen.

`ChatBottomObstruction.composerClearance` reserves:

```
resting capsule height + bottom padding + bubble gap − last cell's bottom padding
  = resting capsule height + bottom padding + cell padding
```

The cell already contributes 6pt below its visible bubble. Counting that padding
again would inflate the visible gap. With current metrics the reserved clearance
is 60pt on iOS and 54pt on macOS.

- iOS supplies this fixed clearance to `ChatPerfListVC`; UIKit adds its safe area
  via `adjustedContentInset`. The existing compaction-status allowance is retained.
  `MessageInputView` no longer sends its expanding height back into list layout.
- macOS keeps the full-height scroll viewport and a fixed document footer. The
  footer now uses current capsule metrics rather than the old 56pt footprint plus
  bottom padding and an additional 25pt gap.
- Recording, longer transcription, cancellation and multiline drafts do not
  move the conversation. The glass grows upward over the existing messages.
  Its growth above the resting footprint (`ChatBottomObstruction.composerOverlay`)
  is added to the scrollable range only — an extra content inset on iOS, an
  extra document footer on macOS — so the reader can push the covered bubbles up
  above the glass. The newest edge (follow-tail, ↓, distance-to-bottom) still
  rests on the resting composer: nothing follows the growth. A follow pin while
  the reader has revealed the covered tail keeps it revealed; when the glass
  collapses, only the no-longer-reachable part is given back. Keyboard avoidance,
  sending and actual message growth remain separate behaviors.

## Verification

`ComposerGeometryProbeTests` runs on both native test targets. It mounts real
ChatView/composer/list controls with an isolated store and deterministic speech:
no credentials, network or microphone. It covers both following the newest edge
and reading history, tracking the **same message** by sequence through all phases.
It asserts stable bubble coordinates, viewport/content geometry and scroll offset,
resting gaps, fixed Mac capsule bottom, actual overlap for long Mac dictation, and
that the covered tail can be scrolled into view and stays there until the glass
collapses.

Run with `KRAKI_RUN_UI_TESTS=1`; use `CODE_SIGNING_ALLOWED=NO` for the local Mac host.
The suite also emits geometry JSON and iOS native captures. Mac geometry/capture
requests go to `/tmp/kraki-composer-geometry-review`; accurate Liquid Glass images
require a WindowServer capture of the indicated test window while the desktop is
unlocked (not `NSView.cacheDisplay`). Native geometry tests are not visual approval
or a performance benchmark. A keyboard appearing/disappearing can legitimately
move the conversation; these no-keyboard voice scenarios isolate composer growth.
