import XCTest
@testable import Kraki

/// K-074: outages, send problems and pairing results changed the screen away
/// from the VoiceOver cursor without any announcement.
@MainActor
final class AccessibilityAnnouncerTests: XCTestCase {
    private var spoken: [String] = []
    private var originalPost: (@MainActor (String) -> Void)?

    override func setUp() {
        super.setUp()
        originalPost = AccessibilityAnnouncer.post
        AccessibilityAnnouncer.post = { [weak self] in self?.spoken.append($0) }
    }

    override func tearDown() {
        if let originalPost { AccessibilityAnnouncer.post = originalPost }
        DeviceTrustModel.shared.feedback = nil
        super.tearDown()
    }

    private func settle(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func testLastingOutageAndRecoveryAreAnnounced() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-announce-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        var spoken: [String] = []
        app.announceForAccessibility = { spoken.append($0) }
        app.connectionStatus = .connected

        app.connectionStatus = .connecting
        settle(0.4)
        app.connectionStatus = .connected
        settle(AppState.reconnectingIndicatorDelay + 0.3)
        XCTAssertEqual(spoken, [], "a sub-debounce blip stays silent, as it is not shown")

        app.connectionStatus = .disconnected
        settle(AppState.reconnectingIndicatorDelay + 0.3)
        XCTAssertTrue(app.showsReconnecting)
        XCTAssertEqual(spoken, ["Connecting…"])

        app.connectionStatus = .connected
        XCTAssertEqual(spoken, ["Connecting…", "Connected"])
    }

    func testPairingResultsAreAnnounced() {
        let trust = DeviceTrustModel.shared
        trust.feedback = .paired(name: "Studio Mac")
        trust.feedback = .failed(name: "Studio Mac", reason: "wrong_computer")
        trust.feedback = .failed(name: "Studio Mac", reason: "wrong_computer")
        XCTAssertEqual(spoken, ["Paired with Studio Mac",
                                "Couldn't pair with Studio Mac\nThe code belongs to a different computer."])
    }
}

#if os(iOS)
extension ChatUXRegressionTests {
    /// K-074: a message that turns "Awaiting confirmation · Tap to retry"
    /// is announced.
    func testUnconfirmedSendIsAnnounced() throws {
        var spoken: [String] = []
        let fx = try makeFixture(total: 10) { _ in true }
        fx.app.announceForAccessibility = { spoken.append($0) }
        fx.app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        fx.app.commandSender?.confirmationTimeout = .milliseconds(200)
        drain(600)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "no echo"))
        drain(1_000)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .unconfirmed)
        XCTAssertEqual(spoken, ["Awaiting delivery confirmation"])
    }
}
#endif
