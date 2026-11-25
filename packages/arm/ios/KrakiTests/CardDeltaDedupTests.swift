import XCTest
@testable import Kraki

/// K-148: the same `agent_message_delta` envelope delivered twice (an
/// app-layer re-send) doubled the draft text.
@MainActor
final class CardDeltaDedupTests: XCTestCase {
    private let sid = "delta-dedup"
    private let dev = "delta-device"

    private func delta(_ app: AppState, seq: Int, _ content: String, reset: Bool = false) throws {
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "agent_message_delta", "sessionId": sid, "deviceId": dev, "seq": seq, "timestamp": ISO8601.now(),
            "payload": ["content": content, "reset": reset],
        ]))
    }

    func testRepeatedDeltaEnvelopeIsAppliedOnce() throws {
        let app = AppState(testDatabase: MessageDatabase(inMemory: ()))
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "Mac", agent: "pi", title: "t", state: .active, mode: .auto,
            lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.deviceStore.addDevice(DeviceSummary(id: dev, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        app.sessionSubscriptionController.onSessionList(tentacleId: dev)
        app.sessionSubscriptionController.setDesired(sid)
        app.sessionSubscriptionController.onAck(SessionSubscriptionAck(
            tentacleId: dev, sessionId: sid, accepted: true, snapshot: nil, errorMessage: nil))
        XCTAssertTrue(app.sessionSubscriptionController.acceptsLive(sid))
        app.messageStore.beginCardTurn(sid)
        try delta(app, seq: 40, "Here is", reset: true)
        try delta(app, seq: 41, " what I fou")
        try delta(app, seq: 41, " what I fou")
        try delta(app, seq: 42, "nd.")
        XCTAssertEqual(app.messageStore.cards[sid]?.text, "Here is what I found.")
    }

    func testDeltasWithoutEnvelopeSeqStillAppend() {
        let store = MessageStore(db: MessageDatabase(inMemory: ()))
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "ab", reset: false)
        store.applyCardMessage(sid, "ab", reset: false)
        XCTAssertEqual(store.cards[sid]?.text, "abab")
    }
}
