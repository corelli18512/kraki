import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// The live Steps target (`ChatViewModel.liveTraceSeq`) of the running turn.
/// A prompted turn keeps its prompt (steers stay inside it). A turn the agent
/// started itself after the previous turn settled (e.g. Pi woken by a
/// background run: no user_message, the spine continues after the idle) is
/// targeted at the seq after that idle, which the tentacle resolves to that
/// turn instead of the previous prompt's. iPhone (`presentLiveSteps`) and Mac
/// (`liveTraceSeq` of the list) both read this property.
@MainActor
final class LiveTraceTargetTests: XCTestCase {
    private let sid = "live-trace-session"
    private var root: URL!
    private var app: AppState!

    override func tearDown() async throws {
        app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        try await super.tearDown()
    }

    private func row(_ type: String, _ seq: Int, _ payload: [String: AnyCodable] = [:]) -> ChatMessage {
        ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: "dev",
                    timestamp: "2026-11-05T00:00:00Z", payload: payload)
    }

    private func viewModel(_ rows: [ChatMessage]) throws -> ChatViewModel {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("live-trace-\(UUID().uuidString)")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, rows)
        app = AppState(testDatabase: db)
        let lastSeq = rows.map(\.seq).max() ?? 0
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev", deviceName: "Mac", agent: "pi", title: "Live trace",
            state: .active, mode: .auto, lastSeq: lastSeq, readSeq: lastSeq, messageCount: rows.count,
            createdAt: Date(), pinned: false)
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: lastSeq, deviceId: "dev")
        _ = app.messageStore.loadInitialWindow(sid)
        return ChatViewModel(sessionId: sid, appState: app)
    }

    private var prompt: ChatMessage { row("user_message", 1, ["content": "Fix every lane"]) }

    func testAgentStartedTurnAfterIdleTargetsTheSeqAfterTheIdle() throws {
        let vm = try viewModel([prompt, row("system_message", 2, ["kind": "no_reply"]), row("idle", 3)])
        XCTAssertEqual(vm.liveTraceSeq, 4, "not the previous prompt (1): the tentacle resolves 4 to the running turn")
    }

    func testAgentStartedTurnKeepsItsTargetAcrossItsOwnRowsAndASteer() throws {
        let vm = try viewModel([prompt, row("agent_message", 2, ["content": "T1 done"]), row("idle", 3),
                                row("user_message", 4, ["content": "also CI", "delivery": "steer"])])
        XCTAssertEqual(vm.liveTraceSeq, 4)
    }

    func testPromptedTurnKeepsItsPrompt() throws {
        let vm = try viewModel([prompt, row("agent_message", 2, ["content": "T1 done"]), row("idle", 3),
                                row("user_message", 4, ["content": "next"])])
        XCTAssertEqual(vm.liveTraceSeq, 4)
    }

    func testPromptedTurnWithASteerKeepsItsPrompt() throws {
        let vm = try viewModel([prompt, row("user_message", 2, ["content": "only iOS", "delivery": "steer"])])
        XCTAssertEqual(vm.liveTraceSeq, 1)
    }

    func testNothingLoadedHasNoTarget() throws {
        let vm = try viewModel([])
        XCTAssertNil(vm.liveTraceSeq)
    }
}
