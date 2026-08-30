# Shared native Chat scroll policy

Kraki keeps native scroll containers on each Apple platform while sharing the
product rules that decide Session entry, continuous interactions, user
direction, tail-following, edge paging, animated navigation, and navigation
control visibility.

## Ownership boundary

`ChatScrollPolicy` is a platform-neutral Swift value type. It imports only
CoreGraphics and owns:

- the initial bottom lock;
- whether a real user interaction has enabled edge paging;
- older/newer intent;
- the explicit tail-follow latch;
- the last native offset used to classify movement;
- continuous-interaction generations across drag/momentum/re-grab phases;
- one older-page allowance per continuous interaction;
- newer-page suppression after an older request until explicit newer intent;
- animated-navigation paging suppression;
- shared older/newer edge trigger distances;
- shared navigation-control visibility thresholds, animation timing, and safety timeout;
- the shared 24pt bottom tolerance and 0.5pt movement epsilon.

The native adapters remain responsible for mechanics that cannot safely be
abstracted away:

| UIKit (`ChatPerfListVC`) | AppKit (`MacChatScrollView`) |
| --- | --- |
| `UICollectionView` batch updates | atomic `NSScrollView` snapshots |
| touch drag and deceleration | trackpad, wheel, keyboard, and scroller knob phases |
| FlowLayout invalidation | custom document-view virtualization |
| `contentInset` and keyboard geometry | clip-view bounds and Composer safe-area footer |
| UIKit prepend offset adjustment | AppKit stable-anchor restoration |

Both adapters feed coordinates that increase toward the newest tail. Therefore
a negative offset delta means older-history movement on both platforms.

## Shared invariants

1. Programmatic entry layout never enables pagination.
2. Entry remains pinned to the newest tail until a real user interaction or
   explicit navigation command.
3. Explicit older-history movement wins over the 24pt bottom tolerance.
4. Stationary layout/inset reflections cannot erase older intent.
5. Newer movement reattaches to the tail only inside the shared tolerance.
6. Explicit tail pinning clears older intent but does not itself release the
   entry lock, because initial layout uses the same operation.
7. One continuous interaction can consume at most one older-page request.
8. A fully settled next interaction receives a new older-page allowance.
9. An older-page request suppresses newer recovery until explicit newer intent.
10. Animated latest-start/tail navigation suppresses edge paging and hides both
    navigation controls until it lands or is cancelled by user interaction.
11. Both platforms use a `max(320pt, 2 × viewport)` older prefetch band, a
    320pt newer trigger, and the same navigation-control thresholds.
12. A new Session resets the complete policy atomically.

## Event mapping

- UIKit drag begin/end → `beginUserInteraction` / `endUserInteraction`
- UIKit drag offset → `observeUserOffset`
- iOS status-bar top → one explicit older interaction
- latest-message-start/tail buttons → shared navigation begin/end
- AppKit live-scroll, wheel animation, or knob begin/end → shared interaction begin/end
- AppKit wheel/key direction → `recordUserIntent`
- AppKit knob offset → `observeUserOffset`
- programmatic native reflection → `rememberOffset` plus
  `refreshFollowingTail`, never a synthetic user movement
- either platform edge approach → `shouldRequestOlderPage` /
  `shouldRequestNewerPage`
- either platform navigation rail → `navigationControlVisibility`
- either platform pin-to-bottom → `pinToTail`

## Validation

`ChatScrollPolicyTests` covers the pure state transitions. Production-shaped
native gates remain separate:

- `IOSChatScrollProductionTests` mounts the real UIKit/TextKit list over a
  temporary SQLite fixture;
- macOS `scrollProductionGate` mounts the real AppKit/CoreText list. The
  `history-scroll-production-gate` Scenario Test Page fixture gives it a
  compact rendered tail over deep synthetic history without Relay traffic.

Physical iPhone/iPad touch, ProMotion, Mac trackpad momentum, and scrollbar
interaction remain hardware checks; semantic automation does not claim to
replace them.

## Deliberately native mechanics

No remaining product-level scroll decision is duplicated between the adapters.
Pagination fetch/storage, window trimming, height warming, anchor execution,
and animation remain native mechanics because they require different UIKit and
AppKit transactions. Platform code supplies geometry/loading facts to the
shared policy, executes its decisions, and reports native interaction/navigation
completion back to it.
