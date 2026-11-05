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

    /// K-011: cold launch of a returning user while the relay cannot be
    /// reached. The shell is up from cache; it must say it is signing in,
    /// never blame the computer.
    func testColdLaunchWithUnreachableRelaySaysSigningInAndBlamesNoComputer() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-cold-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.hasCompletedInitialConnect = false
        app.hasStoredCredentials = true
        app.connectionStatus = .connecting
        settle(AppState.reconnectingIndicatorDelay + 0.3)
        XCTAssertTrue(app.showsReconnecting, "a sign-in that cannot complete is shown")
        XCTAssertEqual(app.conversationTitleStatus(syncing: false), "Signing in…")
        app.connectionStatus = .disconnected // refused attempt between retries
        XCTAssertTrue(app.showsReconnecting)

        // Cached devices are all restored offline: unknown presence is not offline.
        XCTAssertNil(MessageInputView.offlineHint(deviceOnline: false, deviceName: "Studio", presenceKnown: false))
        XCTAssertEqual(MessageInputView.offlineHint(deviceOnline: false, deviceName: "Studio", presenceKnown: true),
                       "Studio is offline — message will deliver when it reconnects.")
        let session = SessionInfo(id: "s", deviceId: "d", deviceName: "Studio", agent: "pi", model: "m", title: "t",
                                  state: .idle, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1,
                                  createdAt: Date(), pinned: false)
        let device = DeviceSummary(id: "d", name: "Studio", role: .tentacle, kind: .desktop, publicKey: nil,
                                   encryptionKey: nil, online: false, lastSeen: nil, createdAt: nil)
        let unknown = SessionCardProjection.make(session: session, device: device, preview: nil, draft: nil,
                                                 presenceKnown: false)
        XCTAssertNotEqual(unknown.status, .offline)
        let store = SessionStore(persistenceEnabled: false)
        XCTAssertNotEqual(
            SessionTableController.fingerprint(for: session, store: store, device: device, isAwaitingGreeting: false,
                                               isCompacting: false, presenceKnown: false),
            SessionTableController.fingerprint(for: session, store: store, device: device, isAwaitingGreeting: false,
                                               isCompacting: false, presenceKnown: true),
            "the row refreshes once presence becomes known")

        app.connectionStatus = .connected
        XCTAssertFalse(app.showsReconnecting)
    }
}
