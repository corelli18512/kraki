import XCTest
@testable import Kraki

/// Review group 2 (2026-10-13): a voice input crossing the durable outbox
/// boundary (stage → correct → dispatch → relaunch).
@MainActor
final class OutboxVoicePersistenceTests: XCTestCase {
    private let sid = "outbox-voice"
    private var root: URL!
    private var app: AppState!
    private var url: URL { root.appendingPathComponent("outbox.json") }
    private var sent: [[String: Any]] = []

    override func setUp() async throws {
        try await super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-outbox-voice-\(UUID().uuidString)", isDirectory: true)
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev-1", deviceName: "Mac", agent: "pi", title: "Voice",
            state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: Date(), pinned: false
        )
        app.deviceStore.setDeviceFeatures("dev-1", features: ["idempotent_input"])
        app.testOutboundMessageHandler = { [weak self] message, _, _ in
            if message["type"] as? String == "send_input", let payload = message["payload"] as? [String: Any] {
                self?.sent.append(payload)
            }
            return true
        }
    }

    override func tearDown() async throws {
        app = nil
        try? FileManager.default.removeItem(at: root)
        try await super.tearDown()
    }

    /// 2-11: once dispatched, a relaunch restores and re-sends the corrected
    /// text under the same clientId, never the raw transcript.
    func testDispatchedCorrectedVoiceInputRestoresAndResendsCorrectedText() async throws {
        let first = CommandSender(appState: app, outboxURL: url)
        let clientId = try XCTUnwrap(first.stageInput(sessionId: sid, text: "delete branch main"))
        XCTAssertTrue(first.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "delete branch mine"))
        XCTAssertEqual(sent.last?["text"] as? String, "delete branch mine")
        await first.waitForOutboxWritesForTesting()

        sent.removeAll()
        let relaunched = CommandSender(appState: app, outboxURL: url)
        let restored = try XCTUnwrap(relaunched.pendingInputs(sid).first)
        XCTAssertEqual(restored.content, "delete branch mine")
        relaunched.resendPendingInputs(reason: "test")
        XCTAssertEqual(sent.map { $0["clientId"] as? String }, [clientId])
        XCTAssertEqual(sent.map { $0["text"] as? String }, ["delete branch mine"])
    }

    /// 2-11: a still-correcting voice input keeps restoring its raw transcript
    /// as failed (never sent automatically).
    func testCorrectingVoiceInputStillRestoresRawTranscriptAsFailed() async throws {
        let first = CommandSender(appState: app, outboxURL: url)
        let clientId = try XCTUnwrap(first.stageInput(sessionId: sid, text: "raw words"))
        first.updateStagedInput(sessionId: sid, clientId: clientId, text: "Raw words", original: "raw words")
        await first.waitForOutboxWritesForTesting()

        let relaunched = CommandSender(appState: app, outboxURL: url)
        let restored = try XCTUnwrap(relaunched.pendingInputs(sid).first)
        XCTAssertEqual(restored.content, "raw words")
        XCTAssertEqual(relaunched.pendingState(restored), .failed)
    }

    /// 2-38: raw speech that arrives after Send is persisted, so a relaunch
    /// restores the whole transcript rather than the "…" placeholder.
    func testRawSpeechArrivingAfterSendIsPersisted() async throws {
        let first = CommandSender(appState: app, outboxURL: url)
        let clientId = try XCTUnwrap(first.stageInput(sessionId: sid, text: "…"))
        first.updateStagedInput(sessionId: sid, clientId: clientId, text: "the full sentence",
                                original: "the full sentence")
        await first.waitForOutboxWritesForTesting()

        let relaunched = CommandSender(appState: app, outboxURL: url)
        XCTAssertEqual(relaunched.pendingInputs(sid).first?.content, "the full sentence")
    }
}
