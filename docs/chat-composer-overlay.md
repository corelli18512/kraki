# Native chat composer clearance

Applies to iOS and macOS. Keep the production composer, glass material, controls,
recording animation and bottom placement. The expanding surface is an overlay,
not a reason to resize/re-pin the conversation.

## Spacing contract

At the newest edge with a resting one-line composer:

| Platform | Last bubble → capsule | Capsule → available bottom edge |
| --- | ---: | ---: |
| iOS | 6pt | 6pt, **excluding** the home-indicator safe area |
| macOS | 12pt | 12pt |

The system safe area is additional, not part of the matching visual spacing.
Do not move the iOS capsule down into the home-indicator area. Short conversations
remain top-aligned; this rule must not stretch empty history to fill the screen.

`ChatBottomObstruction.composerClearance` reserves:

```
resting capsule height + 2 × bottom padding − last cell's bottom padding
```

The cell already contributes 6pt below its visible bubble. Counting that padding
again would inflate the visible gap. With current metrics the reserved clearance
is 54pt on both platforms, although the visible capsules/gaps differ.

- iOS supplies this fixed clearance to `ChatPerfListVC`; UIKit adds its safe area
  via `adjustedContentInset`. The existing compaction-status allowance is retained.
  `MessageInputView` no longer sends its expanding height back into list layout.
- macOS keeps the full-height scroll viewport and a fixed document footer. The
  footer now uses current capsule metrics rather than the old 56pt footprint plus
  bottom padding and an additional 25pt gap.
- Recording, longer transcription, cancellation and multiline drafts do not
  change list insets, content height or scroll position. The glass grows upward
  over the existing messages. Keyboard avoidance, sending/follow-tail and actual
  message growth remain separate behaviors.

## Verification

`ComposerGeometryProbeTests` runs on both native test targets. It mounts real
ChatView/composer/list controls with an isolated store and deterministic speech:
no credentials, network or microphone. It covers both following the newest edge
and reading history, tracking the **same message** by sequence through all phases.
It asserts stable bubble coordinates, viewport/content geometry and scroll offset,
resting gaps, fixed Mac capsule bottom, and actual overlap for long Mac dictation.

Run with `KRAKI_RUN_UI_TESTS=1`; use `CODE_SIGNING_ALLOWED=NO` for the local Mac host.
The suite also emits geometry JSON and iOS native captures. Mac geometry/capture
requests go to `/tmp/kraki-composer-geometry-review`; accurate Liquid Glass images
require a WindowServer capture of the indicated test window while the desktop is
unlocked (not `NSView.cacheDisplay`). Native geometry tests are not visual approval
or a performance benchmark. A keyboard appearing/disappearing can legitimately
move the conversation; these no-keyboard voice scenarios isolate composer growth.
