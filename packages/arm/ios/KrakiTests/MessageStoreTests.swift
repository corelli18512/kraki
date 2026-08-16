import XCTest
@testable import Kraki

@MainActor
final class MessageStoreTests: XCTestCase {

    private var database: MessageDatabase!
    private var store: MessageStore!

    override func setUp() async throws {
        try await super.setUp()
        database = try MessageDatabase()
        store = MessageStore(db: database)
        store.clearCard("sess-1")
    }

    override func tearDown() async throws {
        store?.clearCard("sess-1")
        store = nil
        database = nil
        try await super.tearDown()
    }

    func testInitialWindowLoadsThirtyNewestMessages() throws {
        let sessionId = "initial-window"
        let messages = (1...80).map { seq in
            ChatMessage(
                type: seq.isMultiple(of: 2) ? "agent_message" : "user_message",
                seq: seq,
                sessionId: sessionId,
                deviceId: "device",
                timestamp: "2026-08-16T00:00:00Z",
                payload: ["content": AnyCodable("message-\(seq)")]
            )
        }
        try database.insert(sessionId, messages)

        let loaded = store.loadInitialWindow(sessionId)

        XCTAssertEqual(loaded.count, 30)
        XCTAssertEqual(loaded.first?.seq, 51)
        XCTAssertEqual(loaded.last?.seq, 80)
        XCTAssertEqual(store.windowState(sessionId)?.topSeq, 51)
        XCTAssertEqual(store.windowState(sessionId)?.bottomSeq, 80)
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

        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "previous authoritative card", reset: true)
        store.restoreCardTurnGate(sid, from: [user, final])
        XCTAssertNil(store.cards[sid], "a durable conclusion clears a stale retained card on entry")
        store.applyCardMessage(sid, "stale snapshot", reset: true)
        XCTAssertNil(store.cards[sid])

        store.restoreCardTurnGate(sid, from: [user])
        store.applyCardMessage(sid, "live snapshot", reset: true)
        XCTAssertEqual(store.cards[sid]?.text, "live snapshot")
    }

    func testRestoreCardGateKeepsLiveCardUntilSubscriptionReplacement() {
        let sid = "retained-live-card"
        let user = ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: nil,
                               timestamp: nil, payload: ["content": AnyCodable("go")])
        store.beginCardTurn(sid)
        store.applyCardMessage(sid, "locally authoritative", reset: true)

        store.restoreCardTurnGate(sid, from: [user])
        XCTAssertEqual(store.cards[sid]?.text, "locally authoritative")

        store.replaceCardFromSubscription(
            sid, draft: "subscription authority", action: nil, state: .active)
        XCTAssertEqual(store.cards[sid]?.text, "subscription authority")
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

    // MARK: - Pixel-managed history window

    func testPixelManagedWindowRetainsInitialTailFloorAcrossPaging() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-window-floor-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let localStore = MessageStore(db: database)
        let sessionId = "window-floor"
        func message(_ seq: Int) -> ChatMessage {
            ChatMessage(
                type: seq.isMultiple(of: 2) ? "agent_message" : "user_message",
                seq: seq,
                sessionId: sessionId,
                deviceId: "dev-1",
                timestamp: nil,
                payload: ["content": AnyCodable("message-\(seq)")]
            )
        }

        localStore.minimumPixelManagedWindowCount = 15
        localStore.maxWindowPx = 4_800
        localStore.heightForSeq = { _, _ in 1_000 }
        localStore.messages[sessionId] = (11...25).map(message)
        localStore.windows[sessionId] = .init(topSeq: 11, bottomSeq: 25)

        XCTAssertFalse(localStore.trimTailWindowToRenderedHeight(sessionId))
        XCTAssertEqual(localStore.currentWindow(sessionId).map(\.seq), Array(11...25))

        localStore.prependOlderPage(sessionId, (1...10).map(message))
        XCTAssertEqual(localStore.currentWindow(sessionId).count, 25)
        XCTAssertEqual(localStore.currentWindow(sessionId).map(\.seq), Array(1...25))
        XCTAssertEqual(localStore.windowState(sessionId), .init(topSeq: 1, bottomSeq: 25))

        localStore.messages[sessionId] = (1...15).map(message)
        localStore.windows[sessionId] = .init(topSeq: 1, bottomSeq: 15)
        localStore.appendNewerPage(sessionId, (16...25).map(message))
        XCTAssertEqual(localStore.currentWindow(sessionId).map(\.seq), Array(1...25))

        localStore.appendNewerPage(sessionId, (26...35).map(message))
        XCTAssertEqual(localStore.currentWindow(sessionId).count, 25)
        XCTAssertEqual(localStore.currentWindow(sessionId).map(\.seq), Array(11...35))
        XCTAssertEqual(localStore.windowState(sessionId), .init(topSeq: 11, bottomSeq: 35))

        localStore.prependOlderPage(sessionId, (1...10).map(message))
        XCTAssertEqual(localStore.currentWindow(sessionId).count, 25)
        XCTAssertEqual(localStore.currentWindow(sessionId).map(\.seq), Array(1...25))
        XCTAssertEqual(localStore.windowState(sessionId), .init(topSeq: 1, bottomSeq: 25))

        // The contiguous replay/live-ingest path uses expandWindow rather than
        // the sparse-page helpers. It must retain the same pre-call overlap.
        localStore.messages[sessionId] = (11...25).map(message)
        localStore.windows[sessionId] = .init(topSeq: 11, bottomSeq: 25)
        localStore.expandWindow(sessionId, (1...10).map(message))
        XCTAssertEqual(localStore.currentWindow(sessionId).map(\.seq), Array(1...25))
        XCTAssertEqual(localStore.windowState(sessionId), .init(topSeq: 1, bottomSeq: 25))

        localStore.expandWindow(sessionId, (26...35).map(message))
        XCTAssertEqual(localStore.currentWindow(sessionId).count, 25)
        XCTAssertEqual(localStore.currentWindow(sessionId).map(\.seq), Array(11...35))
        XCTAssertEqual(localStore.windowState(sessionId), .init(topSeq: 11, bottomSeq: 35))
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
