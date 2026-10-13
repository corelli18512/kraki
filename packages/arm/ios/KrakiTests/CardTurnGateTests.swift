import XCTest
@testable import Kraki

/// Card-turn gate regressions from review group 2 (2026-10-13): which events
/// open, keep or close the live card's late-frame gate.
@MainActor
final class CardTurnGateTests: XCTestCase {
    private var root: URL!
    private var app: AppState!
    private var router: MessageRouter!
    private let sid = "gate-session"

    override func setUp() async throws {
        try await super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-card-gate-\(UUID().uuidString)", isDirectory: true)
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        app = AppState(testDatabase: database)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev-1", deviceName: "Mac", agent: "pi", title: "Gate",
            state: .active, mode: .safe, lastSeq: 1, readSeq: 1, messageCount: 1,
            createdAt: Date(), pinned: false
        )
        router = MessageRouter(appState: app)
    }

    override func tearDown() async throws {
        router = nil
        app = nil
        try? FileManager.default.removeItem(at: root)
        try await super.tearDown()
    }

    private var store: MessageStore { app.messageStore }

    private func permission(_ id: String) -> ChatMessage {
        ChatMessage(type: "permission", seq: 0, sessionId: sid, deviceId: nil, timestamp: nil,
                    payload: ["id": AnyCodable(id), "toolName": AnyCodable("bash")])
    }

    private func spine(_ type: String, _ seq: Int, _ payload: [String: AnyCodable] = [:]) -> ChatMessage {
        ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: nil, timestamp: nil, payload: payload)
    }

    private func route(_ type: String, seq: Int, payload: [String: Any]) throws {
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": type, "sessionId": sid, "deviceId": "dev-1", "seq": seq,
            "timestamp": "2026-10-13T00:00:00Z", "payload": payload,
        ]))
    }

    /// 2-01: the previous turn closed the gate; the new turn's user_message
    /// arrives only by history replay (no beginCardTurn). An active but still
    /// empty subscription snapshot must reopen the gate so the turn's first
    /// permission shows.
    func testActiveEmptySubscriptionSnapshotReopensClosedGate() {
        store.endCardTurn(sid)
        store.replaceCardFromSubscription(sid, draft: "", action: nil, state: .active)
        XCTAssertNil(store.cards[sid], "an empty snapshot creates no card")

        store.setCardAction(sid, permission("p1"))
        XCTAssertEqual(store.cards[sid]?.action?.type, "permission")
        store.applyCardMessage(sid, "narration", reset: true)
        XCTAssertEqual(store.cards[sid]?.text, "narration")
    }

    func testIdleEmptySubscriptionSnapshotStillClosesGate() {
        store.beginCardTurn(sid)
        store.replaceCardFromSubscription(sid, draft: "", action: nil, state: .idle)
        store.setCardAction(sid, permission("p1"))
        XCTAssertNil(store.cards[sid])
    }

    /// 2-08: a question agent_message lands the lead-in but does not end the
    /// turn; a parallel permission (already shown, or arriving later) stays.
    func testQuestionAgentMessageKeepsGateAndPendingPermission() throws {
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "lead-in", reset: true)
        store.setCardAction(sid, permission("p1"))

        try route("agent_message", seq: 2, payload: [
            "content": "lead-in", "question": ["id": "q1", "text": "Which one?"],
        ])

        XCTAssertEqual(store.cards[sid]?.text, "", "the lead-in moved to the spine")
        XCTAssertEqual(store.cards[sid]?.action?.permissionId, "p1")
        store.setCardAction(sid, permission("p2"))
        XCTAssertEqual(store.cards[sid]?.action?.permissionId, "p2", "gate stays open after a question")
    }

    func testConcludingAgentMessageStillClosesGate() throws {
        store.beginCardTurn(sid)
        store.setCardAction(sid, permission("p1"))
        try route("agent_message", seq: 2, payload: ["content": "done"])
        XCTAssertNil(store.cards[sid])
        store.setCardAction(sid, permission("p2"))
        XCTAssertNil(store.cards[sid])
    }

    /// 2-08: the DB-window restore derivation agrees with live routing.
    func testRestoreGateSkipsQuestionAgentMessage() {
        store.endCardTurn(sid)
        let question = spine("agent_message", 2, [
            "content": AnyCodable("lead-in"),
            "question": AnyCodable(["id": "q1", "text": "Which one?"]),
        ])
        store.restoreCardTurnGate(sid, from: [spine("user_message", 1), question])
        store.setCardAction(sid, permission("p1"))
        XCTAssertEqual(store.cards[sid]?.action?.type, "permission")
    }

    /// 2-37: an `error` row is not a turn boundary (a retrying turn may still
    /// recover); it must not drop the pending permission.
    func testErrorRowKeepsLiveCard() throws {
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "working", reset: true)
        store.setCardAction(sid, permission("p1"))

        try route("error", seq: 3, payload: ["message": "rate limited, retrying"])

        XCTAssertEqual(store.cards[sid]?.text, "working")
        XCTAssertEqual(store.cards[sid]?.action?.permissionId, "p1")
    }
}
