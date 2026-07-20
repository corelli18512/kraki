import XCTest
@testable import Kraki

@MainActor
final class MessageStoreTests: XCTestCase {

    private var store: MessageStore!

    override func setUp() async throws {
        try await super.setUp()
        let db = try MessageDatabase()
        store = MessageStore(db: db)
        store.clearCard("sess-1")
    }

    override func tearDown() async throws {
        store?.clearCard("sess-1")
        store = nil
        try await super.tearDown()
    }

    // MARK: - Card draft (keep-last)

    func testApplyCardMessageAppendsThenResets() {
        store.applyCardMessage("sess-1", "Hello", reset: false)
        store.applyCardMessage("sess-1", " World", reset: false)
        XCTAssertEqual(store.cards["sess-1"]?.text, "Hello World")

        // reset starts a fresh draft segment (keep-last).
        store.applyCardMessage("sess-1", "New segment", reset: true)
        XCTAssertEqual(store.cards["sess-1"]?.text, "New segment")
    }

    func testSetCardActionKeepsDraft() {
        store.applyCardMessage("sess-1", "drafting", reset: false)
        let action = ChatMessage(type: "tool_start", seq: 0, sessionId: nil, deviceId: nil,
                                 timestamp: nil, payload: ["toolName": AnyCodable("bash")])
        store.setCardAction("sess-1", action)
        XCTAssertEqual(store.cards["sess-1"]?.text, "drafting")
        XCTAssertEqual(store.cards["sess-1"]?.action?.toolName, "bash")
    }

    func testCompactionCompatibilityActionOnlySetsRuntimeStatus() {
        let tool = ChatMessage(type: "tool_start", seq: 0, sessionId: nil, deviceId: nil,
                               timestamp: nil, payload: ["toolName": AnyCodable("bash")])
        store.setCardAction("sess-1", tool)
        let compaction = ChatMessage(type: "compaction", seq: 0, sessionId: nil, deviceId: nil,
                                     timestamp: nil, payload: [
                                        "phase": AnyCodable("running"),
                                        "reason": AnyCodable("threshold"),
                                     ])

        store.applyCardAction("sess-1", compaction)

        XCTAssertEqual(store.runtimeStatus("sess-1"), .compacting(reason: .threshold))
        XCTAssertEqual(store.cards["sess-1"]?.action?.type, "tool_start",
                       "compaction must not replace a real card action")
    }

    func testRuntimeEndClearsOnlyCompaction() {
        let question = ChatMessage(type: "question", seq: 0, sessionId: nil, deviceId: nil,
                                   timestamp: nil, payload: ["id": AnyCodable("q1"), "question": AnyCodable("Proceed?")])
        store.setCardAction("sess-1", question)
        store.setCompacting("sess-1", reason: .overflow)

        store.clearRuntimeStatus("sess-1")

        XCTAssertEqual(store.runtimeStatus("sess-1"), .idle)
        XCTAssertEqual(store.cards["sess-1"]?.action?.type, "question")
    }

    func testOrdinaryActivityClearsStaleCompaction() {
        store.setCompacting("sess-1", reason: .manual)
        store.applyCardMessage("sess-1", "model output", reset: false)
        XCTAssertEqual(store.runtimeStatus("sess-1"), .idle)

        store.setCompacting("sess-1", reason: .threshold)
        let tool = ChatMessage(type: "tool_start", seq: 0, sessionId: nil, deviceId: nil,
                               timestamp: nil, payload: ["toolName": AnyCodable("read")])
        store.applyCardAction("sess-1", tool)
        XCTAssertEqual(store.runtimeStatus("sess-1"), .idle)
        XCTAssertEqual(store.cards["sess-1"]?.action?.type, "tool_start")
    }

    func testSubscriptionSnapshotAtomicallyReplacesCard() {
        let sid = "subscription-card"
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "stale", reset: true)
        store.setCardAction(sid, ChatMessage(
            type: "tool_start", seq: 0, sessionId: sid, deviceId: nil, timestamp: nil,
            payload: ["toolName": AnyCodable("old")]))
        let question = ChatMessage(
            type: "question", seq: 0, sessionId: sid, deviceId: nil, timestamp: nil,
            payload: ["id": AnyCodable("q1"), "question": AnyCodable("Continue?")])

        store.replaceCardFromSubscription(
            sid, draft: "authoritative", action: question, state: .active)

        XCTAssertEqual(store.cards[sid]?.text, "authoritative")
        XCTAssertEqual(store.cards[sid]?.action?.type, "question")
    }

    func testIdleSubscriptionSnapshotClosesGateAndCannotReviveCard() {
        let sid = "idle-subscription-card"
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "old", reset: true)
        store.replaceCardFromSubscription(sid, draft: "", action: nil, state: .idle)
        XCTAssertNil(store.cards[sid])

        store.applyCardMessage(sid, "late", reset: true)
        XCTAssertNil(store.cards[sid])
    }

    func testActiveSubscriptionSnapshotCanAuthoritativelyReopenClosedGate() {
        let sid = "active-subscription-card"
        store.endCardTurn(sid)
        store.replaceCardFromSubscription(sid, draft: "restored live", action: nil, state: .active)
        XCTAssertEqual(store.cards[sid]?.text, "restored live")
        store.applyCardMessage(sid, " tail", reset: false)
        XCTAssertEqual(store.cards[sid]?.text, "restored live tail")
    }

    func testSubscriptionCompactionActionStaysInRuntimeDomain() {
        let sid = "subscription-compaction"
        let compaction = ChatMessage(
            type: "compaction", seq: 0, sessionId: sid, deviceId: nil, timestamp: nil,
            payload: ["reason": AnyCodable("threshold")])
        store.applyCardAction(sid, compaction)
        store.replaceCardFromSubscription(sid, draft: "", action: nil, state: .compacting)
        store.setCompacting(sid, reason: .threshold)
        XCTAssertNil(store.cards[sid])
        XCTAssertEqual(store.runtimeStatus(sid), .compacting(reason: .threshold))
    }

    func testClearCardDropsEverything() {
        store.applyCardMessage("sess-1", "x", reset: false)
        store.clearCard("sess-1")
        XCTAssertNil(store.cards["sess-1"])
    }

    func testSteerUserMessagePreservesCurrentCard() {
        let sid = "steer-card-turn"
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "working", reset: true)
        let permission = ChatMessage(
            type: "permission", seq: 0, sessionId: sid, deviceId: nil, timestamp: nil,
            payload: ["id": AnyCodable("p1"), "toolName": AnyCodable("shell")]
        )
        store.setCardAction(sid, permission)

        store.beginCardTurn(sid, delivery: "steer")

        XCTAssertEqual(store.cards[sid]?.text, "working")
        XCTAssertEqual(store.cards[sid]?.action?.type, "permission")
    }

    func testConcludedTurnRejectsLateDraftAndActionUntilNextUserTurn() {
        let sid = "late-card-turn"
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "process narration", reset: true)
        XCTAssertEqual(store.cards[sid]?.text, "process narration")

        store.endCardTurn(sid)
        store.applyCardMessage(sid, "late stale narration", reset: true)
        store.setCardAction(sid, ChatMessage(
            type: "tool_start", seq: 0, sessionId: sid, deviceId: nil, timestamp: nil,
            payload: ["toolName": AnyCodable("bash")]))
        XCTAssertNil(store.cards[sid], "late transient events must not revive a concluded turn")

        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "next turn", reset: true)
        XCTAssertEqual(store.cards[sid]?.text, "next turn")
    }

    func testRestoreCardGateUsesLatestPersistedConversationBoundary() {
        let sid = "restored-card-turn"
        let user = ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: nil,
                               timestamp: nil, payload: ["content": AnyCodable("go")])
        let final = ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: nil,
                                timestamp: nil, payload: ["content": AnyCodable("done")])

        store.restoreCardTurnGate(sid, from: [user, final])
        store.applyCardMessage(sid, "stale snapshot", reset: true)
        XCTAssertNil(store.cards[sid])

        store.restoreCardTurnGate(sid, from: [user])
        store.applyCardMessage(sid, "live snapshot", reset: true)
        XCTAssertEqual(store.cards[sid]?.text, "live snapshot")
    }

    // MARK: - Trace (per-turn steps, in-memory)

    func testSetAndReadTurnSteps() {
        let steps = [
            ChatMessage(type: "tool_start", seq: 0, sessionId: nil, deviceId: nil,
                        timestamp: nil, payload: ["toolName": AnyCodable("read"), "toolCallId": AnyCodable("c1")]),
            ChatMessage(type: "tool_complete", seq: 0, sessionId: nil, deviceId: nil,
                        timestamp: nil, payload: ["toolName": AnyCodable("read"), "toolCallId": AnyCodable("c1")]),
        ]
        store.setTurnSteps("sess-1", bubbleSeq: 12, steps)
        XCTAssertEqual(store.turnSteps("sess-1", bubbleSeq: 12)?.count, 2)
        XCTAssertNil(store.turnSteps("sess-1", bubbleSeq: 99))
    }

    // MARK: - Reset

    func testResetClearsCardsTracesAndRuntimeStatus() {
        store.applyCardMessage("sess-1", "x", reset: false)
        store.setCompacting("sess-1", reason: .threshold)
        store.setTurnSteps("sess-1", bubbleSeq: 1, [])
        store.reset()
        XCTAssertTrue(store.runtimeStatusBySession.isEmpty)
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertTrue(store.traces.isEmpty)
    }
}
