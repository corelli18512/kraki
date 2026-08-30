# iOS Chat scroll production gate

The iOS Debug test `IOSChatScrollProductionTests.testProductionScrollGate` mounts the
real `ChatPerfListVC`, `UICollectionView`, TextKit bubble cells, `MessageStore`, and
DB-first `MessageProvider` against a temporary simulator database. Entry,
user-direction, tail-follow, and edge-paging eligibility are decided by the
same platform-neutral `ChatScrollPolicy` used by macOS; UIKit still executes
native geometry and pagination transactions. See `docs/chat-scroll-policy.md`.

It validates:

- entry at the newest tail with valid content geometry;
- programmatic entry scroll callbacks cannot page older history before the first user gesture;
- explicit first-upward intent survives a late Composer inset even inside the bottom-follow tolerance;
- first upward history pagination and exact prepend anchoring;
- one older-page request per continuous gesture, with the next settled gesture re-armed;
- materialized visible cells while asynchronous page measurement settles;
- repeated distinct upward gestures without blank cells or duplicate spine identities;
- later upward approaches continuing to load older pages;
- oldest-boundary clamping;
- downward recovery of a px-trimmed newer page;
- width/height reflow with valid offset bounds and visible cell materialization.

Run the focused gate on an available iOS Simulator:

```bash
xcodebuild \
  -project packages/arm/ios/Kraki.xcodeproj \
  -scheme Kraki \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UDID>' \
  -derivedDataPath /tmp/kraki-ios-scroll-gate-derived \
  CODE_SIGNING_ALLOWED=NO \
  test -only-testing:KrakiTests/IOSChatScrollProductionTests/testProductionScrollGate
```

The fixture uses a temporary SQLite database and a test-only app graph. It does not
open the production database, relay, credentials, or production Session. The small
`#if DEBUG` follow-state probe avoids global/synthetic input while leaving pagination,
measurement, UIKit batch updates, and anchor correction on their production paths.

For visible hands-on validation, install the Debug app on a disposable Simulator
and launch its isolated 240-message production-list fixture:

```bash
xcrun simctl install <SIMULATOR_UDID> /path/to/Debug-iphonesimulator/Kraki.app
SIMCTL_CHILD_KRAKI_IOS_VISIBLE_SCROLL_SCENARIO=1 \
  xcrun simctl launch --terminate-running-process \
  <SIMULATOR_UDID> chat.kraki.ios
```

Add `SIMCTL_CHILD_KRAKI_IOS_VISIBLE_SCROLL_AUTORUN=1` to visibly execute six
checks in the foreground production list: entry tail lock, first 12pt upward
intent across a late Composer inset, tail navigation, latest-message-start
navigation, one older page per continuous gesture, and next-gesture re-arming.
The header finishes at `PASSED · 6/6 visible production-scroll checks` and each
assertion is also emitted under `[ios-visible-scroll]` in the Simulator log.

This launch bypasses `RootView`, authentication, push setup, and Relay lifecycle
handling; closing the Debug app destroys its process-local fixture.
