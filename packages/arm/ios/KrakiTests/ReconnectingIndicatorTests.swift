import XCTest
@testable import Kraki

/// "Reconnecting" is shown only for outages that last: a transport blip that
/// recovers within the debounce never flashes a warning (G8).
@MainActor
final class ReconnectingIndicatorTests: XCTestCase {
    private func settle(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func testBlipsAreHiddenAndLastingOutagesShown() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-reconnect-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        XCTAssertFalse(app.showsReconnecting)

        app.connectionStatus = .connecting
        settle(0.5)
        app.connectionStatus = .connected
        settle(AppState.reconnectingIndicatorDelay + 0.3)
        XCTAssertFalse(app.showsReconnecting, "a sub-debounce blip never shows")

        app.connectionStatus = .disconnected
        settle(0.3)
        XCTAssertFalse(app.showsReconnecting)
        settle(AppState.reconnectingIndicatorDelay)
        XCTAssertTrue(app.showsReconnecting, "a lasting outage is shown")

        app.connectionStatus = .connected
        XCTAssertFalse(app.showsReconnecting, "recovery clears it at once")
    }
}
