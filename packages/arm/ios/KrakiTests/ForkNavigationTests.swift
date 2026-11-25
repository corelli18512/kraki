import XCTest
@testable import Kraki

@MainActor
final class ForkNavigationTests: XCTestCase {
    private func makeApp() -> AppState {
        let app = AppState.makeUnitTestHost()
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.sessionStore.upsertSession(SessionInfo(
            id: "src", deviceId: "d", deviceName: "D", agent: "pi", title: "Plan",
            state: .idle, mode: .auto, lastSeq: 3, readSeq: 3, messageCount: 3,
            createdAt: Date(), pinned: false))
        return app
    }

    private func requestId(_ app: AppState) throws -> String {
        try XCTUnwrap(app.commandSender?.pendingPlaceholderIds.keys.first)
    }

    func testFastForkOpensDirectlyWithoutPlaceholder() throws {
        let app = makeApp()
        app.commandSender?.forkSession(sessionId: "src")
        let rid = try requestId(app)
        XCTAssertNil(app.sessionStore.navigateToSession, "no placeholder page right away")
        app.commandSender?.resolveCreateRequest(rid, sessionId: "fork")
        XCTAssertEqual(app.sessionStore.navigateToSession, "fork")
        XCTAssertTrue(app.sessionStore.navigationPushesOnTop)
        XCTAssertNil(app.sessionStore.navigationReplacesPlaceholder)
    }

    func testSlowForkShowsNamedPlaceholderThenReplacesIt() async throws {
        let app = makeApp()
        app.commandSender?.forkSession(sessionId: "src")
        let rid = try requestId(app)
        // The placeholder appears after the product's 450 ms delay: poll for it
        // (a fixed sleep missed it on a slow CI runner).
        let deadline = Date().addingTimeInterval(5)
        while app.sessionStore.navigateToSession == nil, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        let placeholder = try XCTUnwrap(app.sessionStore.navigateToSession)
        XCTAssertEqual(app.sessionStore.pendingSessionTitles[placeholder], "Fork of Plan")
        app.sessionStore.navigateToSession = nil
        app.commandSender?.resolveCreateRequest(rid, sessionId: "fork")
        XCTAssertEqual(app.sessionStore.navigateToSession, "fork")
        XCTAssertEqual(app.sessionStore.navigationReplacesPlaceholder, placeholder)
    }

    /// K-009: the computer reports a failed fork as `error` with an empty
    /// sessionId and the requestId. It must fail the placeholder at once with
    /// that reason, not leave it spinning until the 30 s timeout.
    func testForkFailureFromComputerShowsItsReason() throws {
        let app = makeApp()
        app.commandSender?.forkSession(sessionId: "src")
        let rid = try requestId(app)
        let placeholder = try XCTUnwrap(app.commandSender?.pendingPlaceholderIds[rid])
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "error", "sessionId": "", "deviceId": "d", "seq": 0,
            "payload": ["message": "Couldn't copy the session: disk full", "requestId": rid],
        ]))
        XCTAssertEqual(app.sessionStore.pendingSessionErrors[placeholder], "Couldn't copy the session: disk full")
        XCTAssertNil(app.commandSender?.pendingPlaceholderIds[rid])
        XCTAssertEqual(app.sessionStore.navigateToSession, placeholder, "the fast failure is shown")
    }

    /// K-009: same for a failed create (e.g. the agent is not installed).
    func testCreateFailureFromComputerShowsItsReason() throws {
        let app = makeApp()
        let rid = try XCTUnwrap(app.commandSender?.createSession(targetDeviceId: "d", agentId: "pi", model: "m"))
        let placeholder = try XCTUnwrap(app.commandSender?.pendingPlaceholderIds[rid])
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "error", "sessionId": "", "deviceId": "d", "seq": 0,
            "payload": ["message": "Couldn't create the session: pi is not installed", "requestId": rid],
        ]))
        XCTAssertEqual(app.sessionStore.pendingSessionErrors[placeholder], "Couldn't create the session: pi is not installed")
        XCTAssertNil(app.commandSender?.pendingPlaceholderIds[rid])
    }

    func testForkAnnouncementKeepsListStateAndSeedsHistory() throws {
        let app = makeApp()
        let rows = (1...3).map { ChatMessage(type: $0 == 2 ? "agent_message" : "user_message", seq: $0, sessionId: "src",
                                              deviceId: "d", timestamp: nil, payload: ["content": AnyCodable("m\($0)")]) }
        try app.messageStore.db.insert("src", rows)
        app.commandSender?.forkSession(sessionId: "src")
        let rid = try requestId(app)
        // The session list (sent first) already has the fork, named and idle.
        app.sessionStore.upsertSession(SessionInfo(
            id: "fork", deviceId: "d", deviceName: "D", agent: "pi", title: "Fork of Plan",
            state: .idle, mode: .auto, lastSeq: 3, readSeq: 3, messageCount: 3,
            createdAt: Date(), pinned: false))
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_created", "sessionId": "fork", "deviceId": "d", "seq": 0,
            "payload": ["agent": "pi", "lastSeq": 3, "requestId": rid],
        ]))
        XCTAssertEqual(app.messageStore.dbLastSeq("fork"), 3)
        XCTAssertEqual(app.sessionStore.sessions["fork"]?.state, .idle)
        XCTAssertEqual(app.sessionStore.sessions["fork"]?.title, "Fork of Plan")
        XCTAssertEqual(app.sessionStore.navigateToSession, "fork")
    }
}
