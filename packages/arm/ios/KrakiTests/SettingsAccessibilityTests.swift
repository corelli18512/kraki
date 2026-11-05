#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// K-075: the Settings -> Notifications switch had an empty label
/// (`Toggle("")` + `.labelsHidden()`), so VoiceOver read an unnamed switch.
@MainActor
final class SettingsAccessibilityTests: XCTestCase {
    private var tree: AccessibilityTreeHost?

    override func tearDown() {
        tree?.tearDown()
        tree = nil
        super.tearDown()
    }

    func testNotificationsSwitchHasAccessibleName() throws {
        try requireForegroundUITests()
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let app = AppState.makeUnitTestHost()
        _ = try tree.show(NavigationStack { SettingsView() }.environment(app))

        // A switch exposes its on/off state as the value "0" / "1".
        let switches = tree.elements().filter { ["0", "1"].contains($0.accessibilityValue ?? "") }
        XCTAssertFalse(switches.isEmpty, "the Notifications switch is shown")
        let unnamed = switches.filter { ($0.accessibilityLabel ?? "").isEmpty }
        XCTAssertTrue(unnamed.isEmpty, "unnamed switches: \(unnamed)")
        XCTAssertTrue(switches.contains { $0.accessibilityLabel == "Notifications" })
    }
}
#endif
