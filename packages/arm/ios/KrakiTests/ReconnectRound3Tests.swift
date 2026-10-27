import XCTest
@testable import Kraki

@MainActor
final class ReconnectRound3Tests: XCTestCase {
    private func fixture(_ sid: String) throws -> (AppState, MessageProvider) {
        let app = AppState(testDatabase: MessageDatabase(inMemory: ()))
        app.sessionStore.sessions[sid] = SessionInfo(id: sid, deviceId: "d", deviceName: "d", agent: "pi", model: "m", title: "t", state: .idle, mode: .auto, lastSeq: 12, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices["d"] = DeviceSummary(id: "d", name: "d", role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        let rows = (1...7).map { row(sid, $0) }
        app.messageStore.ingestBatch(sid, rows)
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        let provider = try XCTUnwrap(app.messageProvider)
        provider.setTentacleInfo(sessionId: sid, lastSeq: 12, deviceId: "d")
        provider.ensureLoaded(sessionId: sid, reason: "old-head")
        XCTAssertTrue(provider.isLoadingHead(sid))
        provider.setTentacleInfo(sessionId: sid, lastSeq: 8, deviceId: "d")
        return (app, provider)
    }

    private func row(_ sid: String, _ seq: Int) -> ChatMessage {
        ChatMessage(type: "agent_message", seq: seq, sessionId: sid, deviceId: "d", timestamp: nil, payload: ["content": AnyCodable("restored-\(seq)")])
    }

    func testRetiredReplyThenRealCatchupAcknowledgesRestoredHeadWithoutRefetch() throws {
        let sid = "r3-retired-then-current"
        let (app, provider) = try fixture(sid)
        defer { app.disconnect() }
        provider.handleBatch(sessionId: sid, messages: [], lastSeq: 12, totalLastSeq: 12, containsHead: true)
        XCTAssertEqual(app.messageStore.persistedHead(sid), 7)
        XCTAssertEqual(provider.tentacleLastKnownSeq(sid), 8)
        provider.ensureLoaded(sessionId: sid, reason: "restored-head")
        XCTAssertTrue(provider.isLoadingHead(sid))
        provider.handleBatch(sessionId: sid, messages: [row(sid, 8)], lastSeq: 8, totalLastSeq: 8, containsHead: true)
        XCTAssertEqual(app.messageStore.persistedHead(sid), 8)
        XCTAssertEqual(app.messageStore.dbLastSeq(sid), 8)
        XCTAssertFalse(provider.isLoadingHead(sid))
        provider.ensureLoaded(sessionId: sid, reason: "already-restored")
        XCTAssertFalse(provider.isLoadingHead(sid))
    }

    func testOldReplyCannotStealNewHeadSlotAfterHeadDrop() throws {
        let sid = "r3-new-request-before-old-reply"
        let (app, provider) = try fixture(sid)
        defer { app.disconnect() }
        // Stream-0 lower-head notification triggers another view load before
        // the old bulk-stream reply arrives. That reply is not this new request.
        provider.ensureLoaded(sessionId: sid, reason: "restored-head-before-old-reply")
        XCTAssertTrue(provider.isLoadingHead(sid))
        provider.handleBatch(sessionId: sid, messages: [], lastSeq: 12, totalLastSeq: 12, containsHead: true)
        XCTAssertEqual(app.messageStore.persistedHead(sid), 7, "obsolete acknowledgement must not cover restored row 8")
        XCTAssertEqual(provider.tentacleLastKnownSeq(sid), 8)
        XCTAssertTrue(provider.isLoadingHead(sid), "old reply must not consume the replacement request's slot")
        provider.handleBatch(sessionId: sid, messages: [row(sid, 8)], lastSeq: 8, totalLastSeq: 8, containsHead: true)
        XCTAssertEqual(app.messageStore.dbLastSeq(sid), 8)
        XCTAssertEqual(app.messageStore.persistedHead(sid), 8)
        XCTAssertEqual(provider.tentacleLastKnownSeq(sid), 8)
        provider.ensureLoaded(sessionId: sid, reason: "current-answer")
        XCTAssertFalse(provider.isLoadingHead(sid))
    }

    /// Round 4: an unrelated older-page reply must not end the after-drop window.
    func testOlderPageReplyDoesNotEndTheAfterDropWindow() throws {
        let sid = "r4-older-page-first"
        let (app, provider) = try fixture(sid)
        defer { app.disconnect() }
        provider.ensureLoaded(sessionId: sid, reason: "replacement")
        XCTAssertTrue(provider.isLoadingHead(sid))
        // An older page (below the known head) lands first...
        provider.handleBatch(sessionId: sid, messages: [row(sid, 3)], lastSeq: 3, totalLastSeq: 3, containsHead: false)
        // ...then the obsolete head-12 reply: still rejected, slot kept.
        provider.handleBatch(sessionId: sid, messages: [row(sid, 9), row(sid, 12)], lastSeq: 12, totalLastSeq: 12, containsHead: true)
        XCTAssertTrue(provider.isLoadingHead(sid), "the replacement head request is still outstanding")
        XCTAssertLessThanOrEqual(app.messageStore.dbLastSeq(sid), 8)
        XCTAssertEqual(provider.tentacleLastKnownSeq(sid), 8)
    }
}
