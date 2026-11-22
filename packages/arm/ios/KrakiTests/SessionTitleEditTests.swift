import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Session title editing and its echoes, shared by iOS and macOS: the title
/// editor (Session Info), clearing a manual title, and an offline rename that
/// reaches the computer after its session list.
@MainActor
final class SessionTitleEditTests: XCTestCase {
    private var renames: [String] = []

    private func makeApp(title: String?, autoTitle: String?) -> AppState {
        let app = AppState.makeUnitTestHost()
        renames = []
        app.testOutboundMessageHandler = { [weak self] msg, _, _ in
            if msg["type"] as? String == "rename_session" {
                self?.renames.append((msg["payload"] as? [String: Any])?["title"] as? String ?? "?")
            }
            return true
        }
        app.sessionStore.upsertSession(SessionInfo(
            id: "s", deviceId: "d", deviceName: "D", agent: "pi", title: title, autoTitle: autoTitle,
            state: .idle, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1,
            createdAt: Date(), pinned: false))
        return app
    }

    private func route(_ app: AppState, _ message: [String: Any]) throws {
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: message))
    }

    private func sessionList(title: String?, autoTitle: String) -> [String: Any] {
        var digest: [String: Any] = ["id": "s", "agent": "pi", "autoTitle": autoTitle, "state": "idle",
                                     "lastSeq": 1, "readSeq": 1, "messageCount": 1,
                                     "createdAt": "2024-01-01T00:00:00.000Z"]
        if let title { digest["title"] = title }
        return ["type": "session_list", "deviceId": "d", "payload": ["sessions": [digest]]]
    }

    /// K-043: opening the title editor on an auto-titled session and leaving it
    /// unchanged sends nothing (the auto title stays an auto title).
    func testUnchangedTitleEditIsNotARename() {
        let auto = SessionInfo(id: "s", deviceId: "d", deviceName: "D", agent: "pi", title: nil, autoTitle: "Fix login",
                               state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
                               createdAt: Date(), pinned: false)
        XCTAssertNil(auto.titleEdit("Fix login"))
        XCTAssertNil(auto.titleEdit("  Fix login \n"))
        XCTAssertNil(auto.titleEdit(""), "no manual title to clear")
        XCTAssertEqual(auto.titleEdit("Fix sign-in"), "Fix sign-in")

        var manual = auto
        manual.title = "Login"
        XCTAssertNil(manual.titleEdit("Login"))
        XCTAssertEqual(manual.titleEdit(""), "", "clearing a manual title is a rename")
        XCTAssertEqual(manual.titleEdit("Fix login"), "Fix login")
    }

    /// K-044: clearing a manual title shows the auto title at once, and the
    /// computer's echo (manual title absent) clears it on every device.
    func testClearingAManualTitleShowsTheAutoTitle() throws {
        let app = makeApp(title: "Manual", autoTitle: "Auto")
        app.commandSender?.renameSession(sessionId: "s", title: "")
        XCTAssertEqual(renames, [""])
        XCTAssertNil(app.sessionStore.sessions["s"]?.title)
        XCTAssertEqual(app.sessionStore.sessions["s"]?.displayTitle, "Auto")

        // Another device cleared it: only the echo arrives here.
        let other = makeApp(title: "Manual", autoTitle: "Auto")
        try route(other, ["type": "session_title_updated", "sessionId": "s", "deviceId": "d",
                          "payload": ["autoTitle": "Auto"]])
        XCTAssertNil(other.sessionStore.sessions["s"]?.title)
        XCTAssertEqual(other.sessionStore.sessions["s"]?.displayTitle, "Auto")
    }

    /// K-147: an offline rename is delivered after reconnect, but the computer
    /// may list its sessions first. That list must not bring the old title back.
    func testRenameSurvivesASessionListSentBeforeIt() throws {
        let app = makeApp(title: "Old", autoTitle: "Auto")
        app.commandSender?.renameSession(sessionId: "s", title: "New")
        try route(app, sessionList(title: "Old", autoTitle: "Auto"))
        XCTAssertEqual(app.sessionStore.sessions["s"]?.title, "New", "no flash of the old title")

        try route(app, ["type": "session_title_updated", "sessionId": "s", "deviceId": "d",
                        "payload": ["title": "New", "autoTitle": "Auto"]])
        XCTAssertEqual(app.sessionStore.sessions["s"]?.title, "New")
        // Confirmed: later lists are authoritative again.
        try route(app, sessionList(title: "Renamed elsewhere", autoTitle: "Auto"))
        XCTAssertEqual(app.sessionStore.sessions["s"]?.title, "Renamed elsewhere")
    }

    /// K-147: an auto title the computer sent before it got the rename (it
    /// carries the old manual title, or none) keeps the rename pending: the
    /// title stays, and a list sent before the rename still cannot undo it.
    func testAutoTitleBeforeTheRenameKeepsIt() throws {
        let app = makeApp(title: nil, autoTitle: "Auto")
        app.commandSender?.renameSession(sessionId: "s", title: "New")
        try route(app, ["type": "session_title_updated", "sessionId": "s", "deviceId": "d",
                        "payload": ["autoTitle": "X"]])
        XCTAssertEqual(app.sessionStore.sessions["s"]?.title, "New")
        XCTAssertEqual(app.sessionStore.sessions["s"]?.autoTitle, "X")
        try route(app, sessionList(title: nil, autoTitle: "X"))
        XCTAssertEqual(app.sessionStore.sessions["s"]?.title, "New", "the stale list keeps the rename")

        // The rename's own echo confirms it; lists are authoritative again.
        try route(app, ["type": "session_title_updated", "sessionId": "s", "deviceId": "d",
                        "payload": ["title": "New", "autoTitle": "X"]])
        try route(app, sessionList(title: "Elsewhere", autoTitle: "X"))
        XCTAssertEqual(app.sessionStore.sessions["s"]?.title, "Elsewhere")
    }

    /// K-147: a cleared title is not brought back by an earlier list either.
    func testClearedTitleSurvivesASessionListSentBeforeIt() throws {
        let app = makeApp(title: "Old", autoTitle: "Auto")
        app.commandSender?.renameSession(sessionId: "s", title: "")
        try route(app, sessionList(title: "Old", autoTitle: "Auto"))
        XCTAssertNil(app.sessionStore.sessions["s"]?.title)
        try route(app, sessionList(title: nil, autoTitle: "Auto"))
        try route(app, sessionList(title: "Later", autoTitle: "Auto"))
        XCTAssertEqual(app.sessionStore.sessions["s"]?.title, "Later", "a matching list confirms the rename")
    }
}
