import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Steer placement (MessageStore+SteerPlacement): the live card is never
/// split. While the agent is still writing the segment it started before a
/// steer, the card stays above the steer; its next segment, and the turn's
/// reply, go below it. Data level, so it holds for the iPhone list and the Mac
/// list alike (both place the card with `SessionCard.rowIndex(in:)`).
@MainActor
final class SteerPlacementTests: XCTestCase {
    private let sid = "steer-session"
    private var root: URL!
    private var app: AppState!
    private var router: MessageRouter!

    override func setUp() async throws {
        try await super.setUp()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("steer-placement-\(UUID().uuidString)")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, [ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "dev",
                                        timestamp: "2026-10-13T00:00:00Z", payload: ["content": AnyCodable("Refactor it")])])
        app = AppState(testDatabase: db)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev", deviceName: "Mac", agent: "pi", title: "Steer",
            state: .active, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1, createdAt: Date(), pinned: false)
        app.testOutboundMessageHandler = { _, _, _ in true }
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
    private func delta(_ text: String, reset: Bool = false) {
        app.messageStore.applyCardMessage(sid, text, reset: reset)
    }

    /// The list rows as the user reads them, the live card at its row.
    private func shown() -> [String] {
        let vm = ChatViewModel(sessionId: sid, appState: app)
        vm.refreshMessageCache()
        // iPhone reads `displayMessages`, Mac `displayMessages(spineRevision:)`.
        let mac = vm.displayMessages(spineRevision: 1)
        XCTAssertEqual(vm.displayMessages.map(\.id), mac.map(\.id), "iPhone and Mac show the same rows")
        var rows = mac.map { row -> String in
            "\(row.type == "agent_message" ? "agent" : "user"): \(row.content ?? "")"
        }
        if let card = vm.card, !card.text.isEmpty || card.action != nil {
            rows.insert("live: \(card.text)", at: card.rowIndex(in: mac))
        }
        return rows
    }

    func testLocalSteerKeepsCardAboveUntilNewSegmentThenReplyBelow() throws {
        delta("I'll start with the parser.")
        XCTAssertEqual(shown(), ["user: Refactor it", "live: I'll start with the parser."])

        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "Use the new API", delivery: .steer))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        XCTAssertEqual(shown(), ["user: Refactor it", "live: I'll start with the parser.", "user: Use the new API"],
                       "the steer appears below the card; nothing moves")

        // Same segment: the agent has not read the steer yet.
        delta(" Then the lexer.")
        XCTAssertEqual(shown(), ["user: Refactor it", "live: I'll start with the parser. Then the lexer.",
                                 "user: Use the new API"])

        // The echo replaces the pending bubble; the card stays above it.
        try route("user_message", seq: 2, ["content": "Use the new API", "clientId": clientId, "delivery": "steer"])
        XCTAssertEqual(shown(), ["user: Refactor it", "live: I'll start with the parser. Then the lexer.",
                                 "user: Use the new API"])

        // A new segment (the agent answering the steer) moves the card below.
        delta("Switching to the new API.", reset: true)
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Use the new API", "live: Switching to the new API."])

        // The turn concludes: the reply lands below the steer, the card goes.
        try route("agent_message", seq: 3, ["content": "Done with the new API."])
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Use the new API", "agent: Done with the new API."])
        XCTAssertNil(app.messageStore.cards[sid])
    }

    /// Tentacle persists a steer when the agent takes it, so its echo can
    /// arrive after the new segment began: the card stays below it.
    func testEchoAfterNewSegmentKeepsCardBelowSteer() throws {
        delta("Writing the essay.")
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "Add seals", delivery: .steer))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        delta("Seals are marine mammals.", reset: true)
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Add seals", "live: Seals are marine mammals."])
        try route("user_message", seq: 2, ["content": "Add seals", "clientId": clientId, "delivery": "steer"])
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Add seals", "live: Seals are marine mammals."])
        // A later steer of the same turn holds the card above it again.
        try route("user_message", seq: 3, ["content": "Shorter", "clientId": "b", "delivery": "steer"])
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Add seals", "live: Seals are marine mammals.", "user: Shorter"])
    }

    func testSteerFromAnotherDeviceKeepsCardAboveItsEcho() throws {
        delta("Reading the tests.")
        try route("user_message", seq: 2, ["content": "Skip the slow ones", "clientId": "other-device", "delivery": "steer"])
        delta(" Found 12.")
        XCTAssertEqual(shown(), ["user: Refactor it", "live: Reading the tests. Found 12.", "user: Skip the slow ones"])
    }

    func testEchoWithoutClientIdMatchesItsRow() throws {
        delta("Reading.")
        try route("user_message", seq: 2, ["content": "Faster", "delivery": "steer"])
        XCTAssertEqual(shown(), ["user: Refactor it", "live: Reading.", "user: Faster"])
    }

    /// The draft emptied (only a tool was showing) and then grows again:
    /// that is the agent's next segment, so it goes below the steer.
    func testWordsAfterAnEmptyDraftMoveCardBelow() throws {
        app.messageStore.setCardAction(sid, ChatMessage(type: "tool_start", seq: 0, sessionId: sid, deviceId: nil,
                                                        timestamp: nil, payload: ["toolName": AnyCodable("read")]))
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        XCTAssertEqual(shown(), ["user: Refactor it", "live: ", "user: A"])
        delta("Reading the file now.")
        XCTAssertEqual(shown(), ["user: Refactor it", "user: A", "live: Reading the file now."])
    }

    func testSteerWithoutVisibleCardPlacesNothing() throws {
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "Hurry", delivery: .steer))
        delta("On it.")
        XCTAssertEqual(shown(), ["user: Refactor it", "user: Hurry", "live: On it."])
    }

    /// A second steer in the same segment: the card stays above the first.
    func testSecondSteerKeepsCardAboveTheFirst() throws {
        delta("One.")
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        delta(" Two.")
        try route("user_message", seq: 3, ["content": "B", "clientId": "b", "delivery": "steer"])
        XCTAssertEqual(shown(), ["user: Refactor it", "live: One. Two.", "user: A", "user: B"])
        delta("Doing both.", reset: true)
        XCTAssertEqual(shown(), ["user: Refactor it", "user: A", "user: B", "live: Doing both."])
    }

    /// A normal prompt starts a fresh card with no placement.
    func testPromptEchoClearsPlacement() throws {
        delta("One.")
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        try route("user_message", seq: 3, ["content": "Next task", "clientId": "n"])
        delta("Starting.")
        XCTAssertEqual(shown(), ["user: Refactor it", "user: A", "user: Next task", "live: Starting."])
    }

    /// A reconnect snapshot carries no placement: the card shows last.
    func testSubscriptionSnapshotShowsCardBelowSteer() throws {
        delta("One.")
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        app.messageStore.replaceCardFromSubscription(sid, draft: "One. Two.", action: nil, state: .active)
        XCTAssertEqual(shown(), ["user: Refactor it", "user: A", "live: One. Two."])
    }

    /// A question lands below the steer; the words after it go below too.
    func testQuestionClearsPlacement() throws {
        delta("One.")
        try route("user_message", seq: 2, ["content": "A", "clientId": "a", "delivery": "steer"])
        try route("agent_message", seq: 3, ["content": "Which file?",
                                            "question": ["id": "q1", "text": "Which file?", "choices": ["x", "y"]]])
        XCTAssertNil(app.messageStore.cards[sid]?.aboveSteer)
        delta("Using x.")
        XCTAssertEqual(shown().last, "live: Using x.")
    }
}
