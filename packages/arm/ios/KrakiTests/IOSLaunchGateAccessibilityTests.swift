#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// K-078: while the launch gate covers the screen, the Sessions shell mounted
/// underneath (UIKit session table, tab bar) must not be reachable by
/// VoiceOver; once the gate leaves it must be.
@MainActor
final class IOSLaunchGateAccessibilityTests: XCTestCase {
    private var tree: AccessibilityTreeHost?

    override func tearDown() {
        tree?.tearDown()
        tree = nil
        super.tearDown()
    }

    private func exposesSessionsShell(_ tree: AccessibilityTreeHost) -> Bool {
        !tree.nodes(identifier: "session-list-table").isEmpty
            || tree.elements().contains { $0.accessibilityLabel == "Sessions" || $0.accessibilityLabel == "Devices" }
    }

    func testHiddenSessionsShellIsNotExposedUnderLaunchGate() async throws {
        try requireForegroundUITests()
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let app = AppState.makeUnitTestHost()
        let coordinator = IOSLaunchCoordinator(minimumVisibleSecondsOverride: 3,
                                               presentationWatchdogSecondsOverride: 30)
        _ = try tree.show(RootView(launchCoordinator: coordinator).environment(app))
        if !app.hasStoredCredentials {
            try await waitBriefly(seconds: 6) { coordinator.phase == .signedOut }
            // Returning user: the shell mounts underneath the gate.
            coordinator.reconcileAuthentication(hasStoredCredentials: true, connectionStatus: .connecting)
        }
        // A returning user's Sessions shell mounts underneath the gate.
        tree.drain(0.8)
        XCTAssertEqual(coordinator.phase, .preparingAuthenticated)
        XCTAssertTrue(coordinator.isLaunchGateVisible)
        // Positive control: the gate's own logo is in the tree.
        XCTAssertTrue(tree.elements().contains { $0.accessibilityLabel == "Kraki" }, "\(tree.describeElements())")
        XCTAssertFalse(exposesSessionsShell(tree), "reachable under the launch gate: \(tree.describeElements())")

        // Not vacuous: the same shell is reachable once the gate has left.
        try await waitBriefly(seconds: 6) { coordinator.phase == .authenticated }
        XCTAssertEqual(coordinator.phase, .authenticated)
        tree.drain(0.6)
        XCTAssertTrue(exposesSessionsShell(tree), "the Sessions shell is reachable after the gate: \(tree.describeElements())")
    }
}
#endif
