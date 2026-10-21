import XCTest
@testable import Kraki_Dev

@MainActor
final class ReconnectRound2Tests: XCTestCase {
    private func makeApp() throws -> (AppState, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-round2-\(UUID())")
        let app = AppState(testDatabase: MessageDatabase(inMemory: ()))
        return (app, root)
    }

    func testLowerHeadDropsAcknowledgementThenEmptyDeltaStopsRefetching() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let sid = "r2-lower"
        let rows = (1...7).map { ChatMessage(type: "agent_message", seq: $0, sessionId: sid, deviceId: "d", timestamp: nil, payload: ["content": AnyCodable("row")]) }
        app.messageStore.ingestBatch(sid, rows)
        app.messageStore.markCaughtUp(sid, through: 12)
        let provider = try XCTUnwrap(app.messageProvider)
        provider.setTentacleInfo(sessionId: sid, lastSeq: 8, deviceId: "d")
        XCTAssertEqual(app.messageStore.persistedHead(sid), 7)
        provider.handleBatch(sessionId: sid, messages: [], lastSeq: 8, totalLastSeq: 8, containsHead: true)
        XCTAssertEqual(app.messageStore.persistedHead(sid), 8)
        provider.setTentacleInfo(sessionId: sid, lastSeq: 8, deviceId: "d")
        XCTAssertEqual(app.messageStore.persistedHead(sid), 8, "unchanged session_list must preserve a valid empty-delta acknowledgement")
    }

    func testLateHistoryReplyFromBeforeHeadDropCannotRestoreOldCaughtUpMark() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let sid = "r2-delayed"
        app.sessionStore.sessions[sid] = SessionInfo(id: sid, deviceId: "d", deviceName: "d", agent: "pi", model: "m", title: "t", state: .idle, mode: .auto, lastSeq: 8, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices["d"] = DeviceSummary(id: "d", name: "d", role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        let rows = (1...7).map { ChatMessage(type: "agent_message", seq: $0, sessionId: sid, deviceId: "d", timestamp: nil, payload: ["content": AnyCodable("row")]) }
        app.messageStore.ingestBatch(sid, rows)
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        let provider = try XCTUnwrap(app.messageProvider)
        provider.setTentacleInfo(sessionId: sid, lastSeq: 12, deviceId: "d")
        provider.ensureLoaded(sessionId: sid, reason: "old-head")
        XCTAssertTrue(provider.isLoadingHead(sid))
        provider.setTentacleInfo(sessionId: sid, lastSeq: 8, deviceId: "d")
        // History is on the bulk Pulse stream; the old response can land after
        // the authoritative lower session_list on stream 0. Old 8..12 were
        // off-spine, but restored Tentacle now has a real spine message at 8.
        provider.handleBatch(sessionId: sid, messages: [], lastSeq: 12, totalLastSeq: 12, containsHead: true)
        XCTAssertLessThanOrEqual(app.messageStore.persistedHead(sid), 8)
        XCTAssertEqual(provider.tentacleLastKnownSeq(sid), 8)
        provider.ensureLoaded(sessionId: sid, reason: "restored-missing-8")
        XCTAssertTrue(provider.isLoadingHead(sid), "old acknowledgement must not suppress fetching the restored head")
    }

    func testUnknownDeviceClearsIdentityButKeyChangedKeepsItForRemoteRetry() throws {
        let (app, root) = try makeApp()
        defer { app.disconnect(); try? FileManager.default.removeItem(at: root) }
        app.relayURL = "ws://127.0.0.1:9"
        app.setupNetworking(outboxURL: root.appendingPathComponent("outbox.json"))
        let auth = try XCTUnwrap(app.authManager)
        auth.useEphemeralKeysForCurrentProcess()
        auth.debugIsolatedIdentity = true
        auth.debugSetStoredDeviceId("r2-device")
        #if os(macOS)
        AuthManager.debugCLICredentialLoader = { _ in nil }
        defer { AuthManager.debugCLICredentialLoader = nil }
        #endif
        auth.handleAuthError(message: ["code": "key_changed", "message": "refresh"])
        XCTAssertTrue(app.hasStoredCredentials)
        auth.handleAuthError(message: ["code": "unknown_device", "message": "removed"])
        XCTAssertFalse(app.hasStoredCredentials)
        XCTAssertNil(app.deviceId)
    }

    func testDuplicateGraceRetainsBudgetAndVoiceFinisherForegroundCancellationDoesNotTearDown() {
        var ended: [Int] = [], expired: [() -> Void] = []
        var next = 0, teardown = 0
        let grace = BackgroundSocketGrace(hooks: .init(canKeep: { true }, setVisible: { _ in }, teardown: { teardown += 1 }, beginTask: { expiry in next += 1; expired.append(expiry); return next }, endTask: { ended.append($0) }))
        let voice = BackgroundVoiceFinisher(hooks: .init(isFinishing: { true }, isDelivered: { false }, retire: {}, teardown: { teardown += 1 }, beginTask: { _ in 100 }, endTask: { ended.append($0) }))
        XCTAssertTrue(voice.beginIfNeeded())
        voice.cancel() // foreground during voice correction
        XCTAssertTrue(grace.begin())
        let old = expired[0]
        XCTAssertTrue(grace.begin()) // duplicate background, one OS task
        XCTAssertEqual(next, 1)
        XCTAssertTrue(grace.resume())
        XCTAssertTrue(grace.begin())
        old() // callback from the voice/earlier background visit cannot close this visit
        XCTAssertTrue(grace.isActive)
        XCTAssertEqual(teardown, 0)
        grace.abandon()
        XCTAssertEqual(ended, [100, 1, 2])
        XCTAssertEqual(teardown, 1)
    }
}
