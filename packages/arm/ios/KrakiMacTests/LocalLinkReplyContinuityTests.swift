import XCTest
@testable import Kraki_Dev

/// A route switch (local link ↔ Head) during a streaming reply re-subscribes
/// the open Session. The reply on screen must stay there while the catch-up
/// runs (K-115); a page-entry snapshot still waits for its user message.
@MainActor
final class LocalLinkReplyContinuityTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("ll-reply-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeApp() throws -> AppState {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.deviceId = "app-1"
        app.sessionStore.sessions["S"] = SessionInfo(
            id: "S", deviceId: "T1", deviceName: "d", agent: "pi", model: "m", title: "t",
            state: .active, mode: .auto, lastSeq: 1, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices["T1"] = DeviceSummary(
            id: "T1", name: "d", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        return app
    }

    /// The Tentacle's answer to the re-subscribe: the turn is still running,
    /// its spine head is 4 (tool events this device never stores).
    private func snapshotAck(draft: String) -> SessionSubscriptionAck {
        SessionSubscriptionAck(
            tentacleId: "T1", sessionId: "S", accepted: true,
            snapshot: [
                "digest": ["id": "S", "agent": "pi", "title": "t", "state": "active", "lastSeq": 4],
                "card": ["draft": draft],
                "spineHeadSeq": 4,
            ],
            errorMessage: nil)
    }

    func testRouteSwitchDuringAReplyKeepsTheReplyOnScreen() throws {
        let app = try makeApp()
        app.messageStore.persist("S", [ChatMessage(type: "user_message", seq: 1, sessionId: "S", deviceId: nil,
                                                   timestamp: nil, payload: ["content": AnyCodable("go")])])
        app.messageStore.beginCardTurn("S")
        app.messageStore.applyCardMessage("S", "Half a reply", reset: true)
        XCTAssertEqual(app.messageStore.visibleCard("S")?.text, "Half a reply")

        app.applySessionSubscriptionSnapshot(snapshotAck(draft: "Half a reply, and more"))

        XCTAssertEqual(app.messageStore.visibleCard("S")?.text, "Half a reply, and more",
                       "the reply must not vanish until the catch-up answers")
    }

    func testOpeningASessionMidTurnStillWaitsForItsUserMessage() throws {
        let app = try makeApp()
        // Nothing of this turn is on screen yet (page entry, not a route switch).
        app.applySessionSubscriptionSnapshot(snapshotAck(draft: "working"))
        XCTAssertNotNil(app.messageStore.cards["S"])
        XCTAssertNil(app.messageStore.visibleCard("S"), "held until this device has the turn's user message")
    }
}
