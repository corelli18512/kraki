import XCTest
@testable import Kraki

/// `reply.summary` wiring: MessageRouter starts a turn only for this device's
/// own echo, follows it, ends it, and the app going to the background closes it.
/// Reuses the ChatUX fixture (a real AppState, CommandSender and outbox).
extension ChatUXRegressionTests {
    private var replyDevice: String { "ux-gate-device" }

    private func registerReplySession(_ app: AppState) {
        guard app.sessionStore.session(for: sid) == nil else { return }
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: replyDevice, deviceName: "Mac", agent: "pi", title: "Reply",
            state: .active, mode: .safe, lastSeq: 10, readSeq: 10, messageCount: 10,
            createdAt: Date(), pinned: false
        )
    }

    private func route(_ router: MessageRouter, _ type: String, _ seq: Int, _ payload: [String: Any]) throws {
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": type, "sessionId": sid, "deviceId": replyDevice, "seq": seq,
            "timestamp": "2026-09-01T00:00:03.000Z", "payload": payload,
        ]))
    }

    func testReplySummaryFollowsTheTurnThisDeviceStarted() throws {
        let fx = try makeFixture(total: 10) { _ in true }
        drain(300)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "hello"))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        registerReplySession(fx.app)
        let router = try XCTUnwrap(fx.app.messageRouter)
        let replies = router.replyMetrics

        // Someone else's message (another device) starts nothing.
        try route(router, "user_message", 11, ["content": "from the phone", "clientId": UUID().uuidString])
        XCTAssertEqual(replies.inFlight, 0)

        try route(router, "user_message", 12, ["content": "hello", "clientId": clientId])
        XCTAssertEqual(replies.inFlight, 1, "this device's echo starts the turn (outbox read before the echo clears it)")
        // Text deltas only reach a subscribed (open) conversation; their
        // timing is covered by ReplyTrackerTests.
        try route(router, "agent_message", 13, ["content": "Hi there"])
        // A steer stays inside the running turn.
        try route(router, "user_message", 14, ["content": "also", "clientId": UUID().uuidString, "delivery": "steer"])
        XCTAssertEqual(replies.inFlight, 1)
        try route(router, "idle", 0, [:])

        XCTAssertEqual(replies.summaries.count, 1)
        let reply = try XCTUnwrap(replies.summaries.last)
        XCTAssertEqual(reply.kind, .typed)
        XCTAssertEqual(reply.outcome, .completed)
        XCTAssertEqual(reply.deltas, 0)
        XCTAssertNotNil(reply.firstActivityMs)
        XCTAssertNotNil(reply.firstTextMs)
        XCTAssertEqual(replies.inFlight, 0)
    }

    func testReplySummaryEndsAsFailedOnAFailedTurnStatus() throws {
        let fx = try makeFixture(total: 10) { _ in true }
        drain(300)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "hello"))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        registerReplySession(fx.app)
        let router = try XCTUnwrap(fx.app.messageRouter)
        try route(router, "user_message", 11, ["content": "hello", "clientId": clientId])
        try route(router, "turn_status", 12, ["action": ["type": "failed"], "draft": ""])
        XCTAssertEqual(router.replyMetrics.summaries.last?.outcome, .failed)
        XCTAssertNil(router.replyMetrics.summaries.last?.firstActivityMs)
    }

    func testReplySummaryClosesWhenTheAppLeavesTheForeground() throws {
        let fx = try makeFixture(total: 10) { _ in true }
        drain(300)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "hello"))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        registerReplySession(fx.app)
        let router = try XCTUnwrap(fx.app.messageRouter)
        try route(router, "user_message", 11, ["content": "hello", "clientId": clientId])
        fx.app.handleBackground()
        XCTAssertEqual(router.replyMetrics.summaries.last?.outcome, .backgrounded)
        fx.app.isInBackground = false
    }
}
