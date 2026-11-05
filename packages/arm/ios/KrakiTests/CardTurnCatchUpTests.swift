import XCTest
@testable import Kraki

/// K-013: a turn that finished while this device was away. The reconnect
/// authority (session_list / idle subscription snapshot) arrives before the
/// catch-up that carries the concluding bubble. The stale draft must stay until
/// that bubble lands and be replaced by it in the same step; removing it first
/// made the reply vanish and slide in again.
@MainActor
final class CardTurnCatchUpTests: XCTestCase {
    private let sid = "catchup-card"
    private let dev = "catchup-device"

    private func makeApp() throws -> AppState {
        let app = AppState(testDatabase: MessageDatabase(inMemory: ()))
        app.deviceStore.addDevice(DeviceSummary(id: dev, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        app.messageStore.ingestBatch(sid, [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: dev, timestamp: nil,
                        payload: ["content": AnyCodable("explain")]),
        ])
        app.messageStore.beginCardTurn(sid)
        app.messageStore.applyCardMessage(sid, "Here is what I fou", reset: true)
        return app
    }

    private func sessionList(_ app: AppState, state: String, lastSeq: Int) throws {
        let digest: [String: Any] = [
            "id": sid, "agent": "pi", "model": "m", "title": "t", "state": state, "mode": "auto",
            "lastSeq": lastSeq, "readSeq": 1, "messageCount": lastSeq,
            "createdAt": "2026-09-01T00:00:00.000Z", "pinned": false,
        ]
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_list", "deviceId": dev, "seq": 1, "timestamp": ISO8601.now(),
            "payload": ["sessions": [digest], "archivedCount": 0, "autoArchiveDays": 14],
        ]))
    }

    private var catchUp: [ChatMessage] {
        [ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: dev, timestamp: nil,
                     payload: ["content": AnyCodable("Here is what I found.")]),
         ChatMessage(type: "idle", seq: 3, sessionId: sid, deviceId: dev, timestamp: nil, payload: [:])]
    }

    func testIdleDigestKeepsTheDraftUntilTheCatchUpLandsItsReply() throws {
        let app = try makeApp()
        try sessionList(app, state: "idle", lastSeq: 3)
        XCTAssertEqual(app.messageStore.visibleCard(sid)?.text, "Here is what I fou",
                       "the draft stays until its concluding bubble arrives")
        // The turn is over: late frames cannot grow the kept draft.
        app.messageStore.applyCardMessage(sid, "und", reset: false)
        XCTAssertEqual(app.messageStore.visibleCard(sid)?.text, "Here is what I fou")

        app.messageProvider?.handleBatch(sessionId: sid, messages: catchUp, lastSeq: 3, totalLastSeq: 3, containsHead: true)
        XCTAssertNil(app.messageStore.visibleCard(sid), "the landed bubble replaces the draft in the same step")
        XCTAssertEqual(app.messageStore.dbLastSeq(sid), 3)
    }

    func testIdleDigestThisDeviceIsCaughtUpToEndsTheCardAtOnce() throws {
        let app = try makeApp()
        try sessionList(app, state: "idle", lastSeq: 1)
        XCTAssertNil(app.messageStore.visibleCard(sid))
    }

    func testKeptDraftIsDroppedWhenTheCatchUpGivesUp() throws {
        let app = try makeApp()
        try sessionList(app, state: "idle", lastSeq: 3)
        XCTAssertNotNil(app.messageStore.visibleCard(sid))
        app.messageStore.releaseCardHold(sid)
        XCTAssertNil(app.messageStore.visibleCard(sid))
    }

    func testIdleSubscriptionSnapshotKeepsTheDraftUntilTheCatchUp() throws {
        let app = try makeApp()
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "Mac", agent: "pi", model: "m", title: "t", state: .active,
            mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1, createdAt: Date(), pinned: false)
        let digest: [String: Any] = [
            "id": sid, "agent": "pi", "model": "m", "title": "t", "state": "idle", "mode": "auto",
            "lastSeq": 3, "readSeq": 1, "messageCount": 3, "createdAt": "2026-09-01T00:00:00.000Z", "pinned": false,
        ]
        app.applySessionSubscriptionSnapshot(SessionSubscriptionAck(
            tentacleId: dev, sessionId: sid, accepted: true,
            snapshot: ["digest": digest, "spineHeadSeq": 3], errorMessage: nil))
        XCTAssertEqual(app.messageStore.visibleCard(sid)?.text, "Here is what I fou")
        app.messageProvider?.handleBatch(sessionId: sid, messages: catchUp, lastSeq: 3, totalLastSeq: 3, containsHead: true)
        XCTAssertNil(app.messageStore.visibleCard(sid))
    }
}
