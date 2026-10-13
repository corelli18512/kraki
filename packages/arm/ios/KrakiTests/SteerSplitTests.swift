import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Steer display (review group 2b, 2026-10-13): while the agent streams a
/// draft, a steer must not end up above the agent's earlier words. Order:
/// earlier agent words → steer → later agent words. Data level, so it holds
/// for the iPhone list and the Mac list alike (both read ChatViewModel).
@MainActor
final class SteerSplitTests: XCTestCase {
    private let sid = "steer-session"
    private var root: URL!
    private var app: AppState!
    private var router: MessageRouter!
    private var sent: [[String: Any]] = []

    override func setUp() async throws {
        try await super.setUp()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("steer-split-\(UUID().uuidString)")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, [ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "dev",
                                        timestamp: "2026-10-13T00:00:00Z", payload: ["content": AnyCodable("Refactor it")])])
        app = AppState(testDatabase: db)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev", deviceName: "Mac", agent: "pi", title: "Steer",
            state: .active, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1, createdAt: Date(), pinned: false)
        app.testOutboundMessageHandler = { [weak self] msg, _, _ in self?.sent.append(msg); return true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 1, deviceId: "dev")
        _ = app.messageStore.loadInitialWindow(sid)
        app.messageStore.beginCardTurn(sid)
        router = MessageRouter(appState: app)
    }

    override func tearDown() async throws {
        router = nil
        app = nil
        try? FileManager.default.removeItem(at: root)
        try await super.tearDown()
    }

    private func route(_ type: String, seq: Int? = nil, _ payload: [String: Any]) throws {
        var envelope: [String: Any] = ["type": type, "sessionId": sid, "deviceId": "dev",
                                       "timestamp": "2026-10-13T00:00:01Z", "payload": payload]
        if let seq { envelope["seq"] = seq }
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: envelope))
    }

    /// Live deltas reach the card only for the subscribed session; apply
    /// them as MessageRouter does once subscribed.
    private func delta(_ text: String, reset: Bool = false) throws {
        app.messageStore.applyCardMessage(sid, text, reset: reset)
    }

    /// The list rows as the user reads them, plus the live bubble's text last.
    private func shown() -> [String] {
        let vm = ChatViewModel(sessionId: sid, appState: app)
        vm.refreshMessageCache()
        // iPhone reads `displayMessages`, Mac `displayMessages(spineRevision:)`.
        let mac = vm.displayMessages(spineRevision: 1)
        XCTAssertEqual(vm.displayMessages.map(\.id), mac.map(\.id), "iPhone and Mac show the same rows")
        var rows = mac.map { row -> String in
            let who = row.type == "agent_message" ? "agent" : "user"
            return "\(who): \(row.content ?? "")"
        }
        if let live = vm.card?.text, !live.isEmpty { rows.append("live: \(live)") }
        return rows
    }

    func testLocalSteerKeepsEarlierWordsAboveItAndLiveShowsOnlyLaterWords() throws {
        try delta("I'll start with the parser.")
        XCTAssertEqual(shown(), ["user: Refactor it", "live: I'll start with the parser."])

        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "Use the new API", delivery: .steer))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        XCTAssertEqual(shown(), ["user: Refactor it", "agent: I'll start with the parser.", "user: Use the new API"],
                       "nothing new streamed yet: no live bubble below the steer")

        // The agent's current message keeps streaming in the same segment.
        try delta(" Then the lexer.")
        XCTAssertEqual(shown(), ["user: Refactor it", "agent: I'll start with the parser.", "user: Use the new API",
                                 "live: Then the lexer."])

        // The echo replaces the pending bubble; the split is not repeated.
        try route("user_message", seq: 2, ["content": "Use the new API", "clientId": clientId, "delivery": "steer"])
        XCTAssertEqual(shown(), ["user: Refactor it", "agent: I'll start with the parser.", "user: Use the new API",
                                 "live: Then the lexer."])

        // A new segment (the agent answering the steer) shows whole below it.
        try delta("Switching to the new API.", reset: true)
        XCTAssertEqual(shown(), ["user: Refactor it", "agent: I'll start with the parser.", "user: Use the new API",
                                 "live: Switching to the new API."])

        // The turn concludes: its reply lands below the steer and the
        // transient frozen bubble goes with the card.
        try route("agent_message", seq: 3, ["content": "Done with the new API."])
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Use the new API", "agent: Done with the new API."])
    }

    func testSteerFromAnotherDeviceSplitsWhenItsEchoArrives() throws {
        try delta("Reading the tests.")
        try route("user_message", seq: 2, ["content": "Skip the slow ones", "clientId": "other-device", "delivery": "steer"])
        try delta(" Found 12.")
        XCTAssertEqual(shown(), ["user: Refactor it", "agent: Reading the tests.", "user: Skip the slow ones",
                                 "live: Found 12."])
    }

    func testSteerWithoutVisibleWordsAddsNoFrozenBubble() throws {
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "Hurry", delivery: .steer))
        try delta("On it.")
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Hurry", "live: On it."])
    }

    func testSecondSteerFreezesOnlyTheWordsSinceTheFirst() throws {
        try delta("One.")
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        try delta(" Two.")
        try route("user_message", seq: 3, ["content": "B", "clientId": "b", "delivery": "steer"])
        try delta(" Three.")
        XCTAssertEqual(shown(), ["user: Refactor it", "agent: One.", "user: A", "agent: Two.", "user: B",
                                 "live: Three."])
    }

    /// A normal prompt (or a steer Tentacle ran as a prompt) starts a fresh
    /// card: nothing frozen carries over.
    func testPromptEchoDropsFrozenDrafts() throws {
        try delta("One.")
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        try route("user_message", seq: 3, ["content": "Next task", "clientId": "n"])
        XCTAssertEqual(shown(), ["user: Refactor it", "user: A", "user: Next task"])
    }

    /// A question mid-turn lands its lead-in on the spine; the bubble frozen
    /// above an earlier steer stays until the turn ends.
    func testQuestionKeepsFrozenDraft() throws {
        try delta("One.")
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        try delta(" Which file?")
        try route("agent_message", seq: 3, ["content": "Which file?",
                                            "question": ["id": "q1", "text": "Which file?", "choices": ["x", "y"]]])
        XCTAssertEqual(shown(), ["user: Refactor it", "agent: One.", "user: A", "agent: Which file?"])
        try delta("Using x.")
        XCTAssertEqual(shown().last, "live: Using x.")
    }
}
