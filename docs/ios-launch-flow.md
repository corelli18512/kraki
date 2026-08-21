# iOS Cold-Launch Flow

Kraki iOS uses two launch surfaces:

1. the system-generated static launch screen while iOS creates the process;
2. an in-app `IOSEntryGateView` that remains in control while the real SwiftUI/UIKit application surface materializes.

## Returning authenticated user

1. `RootView` starts in `IOSLaunchCoordinator.Phase.launching` and paints a minimal entry gate containing only the current theme background and centered Kraki logo.
2. The initial Relay connection starts behind the gate. Network readiness does not control whether cached UI can eventually open.
3. `MainTabView` mounts underneath the gate with notification/deep-link navigation disabled.
4. `IOSLaunchPresentationReadyProbe` waits until the UIKit hierarchy is attached to a real `UIWindow`, forces its first layout pass, and reports on the following main-run-loop turn.
5. After both that presentation boundary and the 350 ms visual floor, the gate fades away. A 2-second presentation watchdog provides a bounded fallback if UIKit does not deliver the expected attach callback.
6. Queued Session or Device navigation is then consumed. Chat is never mounted behind the cold-launch gate.

## Signed-out user

The launch gate remains visible for the short visual floor, then routes to the existing iOS `LoginView`. The first WebSocket connection still starts behind the gate so `auth_info` can make GitHub sign-in available.

A successful login stages `MainTabView` through the same presentation boundary. Explicit logout returns directly to `LoginView` and does not replay the cold-launch animation.

## Session-list reconciliation

The initial and reconnecting `session_list` uses `SessionStore.reconcileSessionList`:

- one device-scoped authoritative transaction;
- stale Sessions for that Tentacle removed without touching other devices;
- one observable metadata commit;
- one persistence snapshot scheduled for the entire list.

This avoids the former per-Session `upsert + mode + usage + pin` mutation pattern, which rebuilt the full snapshot hundreds of times and could stall both the iOS Session table and the macOS Sidebar after the main surface was already visible.

## Debug fixture

The iOS Simulator can render the in-app gate without Relay traffic:

```bash
SIMCTL_CHILD_KRAKI_IOS_ENTRY_GATE_PAGE=1 \
  xcrun simctl launch --terminate-running-process <device-udid> chat.kraki.ios
```
