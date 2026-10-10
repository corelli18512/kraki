import XCTest
@testable import Kraki_Dev

@MainActor
final class MacForkNavigationTests: XCTestCase {
    func testForkSelectsTheNewSessionWithoutAPlaceholder() throws {
        let app = AppState.makeUnitTestHost()
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.sessionStore.upsertSession(SessionInfo(
            id: "src", deviceId: "d", deviceName: "D", agent: "pi", title: "Plan",
            state: .idle, mode: .auto, lastSeq: 3, readSeq: 3, messageCount: 3,
            createdAt: Date(), pinned: false))
        app.commandSender?.forkSession(sessionId: "src")
        let rid = try XCTUnwrap(app.commandSender?.pendingPlaceholderIds.keys.first)
        XCTAssertNil(app.sessionStore.navigateToSession)
        app.commandSender?.resolveCreateRequest(rid, sessionId: "fork")
        XCTAssertEqual(app.sessionStore.navigateToSession, "fork")
        XCTAssertEqual(app.sessionStore.sessionListRevealId, "fork")
        XCTAssertTrue(app.sessionStore.pendingSessions.isEmpty)
    }
}
