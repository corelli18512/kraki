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
        XCTAssertFalse(app.sessionStore.navigationReplacesPlaceholder)
    }

    func testSlowForkShowsNamedPlaceholderThenReplacesIt() async throws {
        let app = makeApp()
        app.commandSender?.forkSession(sessionId: "src")
        let rid = try requestId(app)
        try await Task.sleep(for: .milliseconds(700))
        let placeholder = try XCTUnwrap(app.sessionStore.navigateToSession)
        XCTAssertEqual(app.sessionStore.pendingSessionTitles[placeholder], "Fork of Plan")
        app.sessionStore.navigateToSession = nil
        app.commandSender?.resolveCreateRequest(rid, sessionId: "fork")
        XCTAssertEqual(app.sessionStore.navigateToSession, "fork")
        XCTAssertTrue(app.sessionStore.navigationReplacesPlaceholder)
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
