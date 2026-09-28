import XCTest
@testable import Kraki

/// Leaving the app closes the socket on purpose; coming back must not show
/// "Reconnecting" unless the reconnect itself takes longer than the debounce.
@MainActor
final class BackgroundReconnectingTests: XCTestCase {
    private func settle(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    func testBackgroundDisconnectIsNotReconnecting() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-bg-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        app.handleBackground()
        app.connectionStatus = .disconnected
        settle(AppState.reconnectingIndicatorDelay + 0.5)
        XCTAssertFalse(app.showsReconnecting, "backgrounded: intentional, not reconnecting")

        app.handleForegroundRehydrate()
        settle(0.5)
        app.connectionStatus = .connected
        settle(AppState.reconnectingIndicatorDelay + 0.3)
        XCTAssertFalse(app.showsReconnecting, "a quick foreground reconnect never flashes")

        app.handleBackground(); app.connectionStatus = .disconnected
        app.handleForegroundRehydrate()
        settle(AppState.reconnectingIndicatorDelay + 0.5)
        XCTAssertTrue(app.showsReconnecting, "a slow foreground reconnect is shown")
    }
}
