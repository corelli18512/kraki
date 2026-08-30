# iOS Chat scroll production gate

The iOS Debug test `IOSChatScrollProductionTests.testProductionScrollGate` mounts the
real `ChatPerfListVC`, `UICollectionView`, TextKit bubble cells, `MessageStore`, and
DB-first `MessageProvider` against a temporary simulator database.

It validates:

- entry at the newest tail with valid content geometry;
- programmatic entry scroll callbacks cannot page older history before the first user gesture;
- explicit first-upward intent survives a late Composer inset even inside the bottom-follow tolerance;
- first upward history pagination and exact prepend anchoring;
- materialized visible cells while asynchronous page measurement settles;
- repeated continuous upward packets without duplicate spine identities;
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
