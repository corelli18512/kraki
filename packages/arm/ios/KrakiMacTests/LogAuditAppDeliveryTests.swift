import XCTest
@testable import Kraki_Dev

/// Message delivery findings of the log audit 2026-10-22 (app-delivery group).
@MainActor
final class LogAuditAppDeliveryTests: XCTestCase {
    private let sid = "la-delivery"
    private let dev = "la-tentacle"
    private var roots: [URL] = []

    override func tearDown() async throws {
        for root in roots { try? FileManager.default.removeItem(at: root) }
        roots = []
        try await super.tearDown()
    }

    private func makeApp() throws -> AppState {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-la-\(UUID().uuidString)")
        roots.append(root)
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "d", agent: "pi", model: "m", title: "t",
            state: .idle, mode: .auto, lastSeq: 12, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "d", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        return app
    }

    private func outboxURL() -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-la-outbox-\(UUID().uuidString)")
        roots.append(root)
        return root.appendingPathComponent("outbox.json")
    }

    // MARK: - (a) restored outbox keeps kind / length

    /// iPhone diag 10-14 (clientId 94757824…): a voice message restored after
    /// a relaunch was reported `kind=typed textLength=0`.
    func testRestoredVoiceInputKeepsItsKindAndLength() async throws {
        let url = outboxURL()
        let app = try makeApp()
        app.testOutboundMessageHandler = { _, _, _ in true }
        let first = CommandSender(appState: app, outboxURL: url)
        let clientId = try XCTUnwrap(first.stageInput(sessionId: sid, text: "raw words"))
        XCTAssertTrue(first.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "Corrected words."))
        await first.waitForOutboxWritesForTesting()

        // A new process: its own tracker, the same durable outbox.
        let relaunchedApp = try makeApp()
        relaunchedApp.testOutboundMessageHandler = { _, _, _ in true }
        let relaunched = CommandSender(appState: relaunchedApp, outboxURL: url)
        relaunched.clearPending(sid, clientId: clientId)
        let summary = try XCTUnwrap(relaunchedApp.sendMetrics.summaries.last)
        XCTAssertEqual(summary.kind, .voice)
        XCTAssertEqual(summary.textLength, "Corrected words.".utf8.count)
        XCTAssertTrue(summary.restored)
    }

    // MARK: - (b) one resend per return, not two

    /// iPhone diag 10-18 10:32: back from the background, one input was
    /// re-sent on `reconnected` and again 77 ms later on `greeting`.
    func testReconnectAndGreetingResendAnInputOnce() throws {
        let app = try makeApp()
        var sent: [String] = []
        app.testOutboundMessageHandler = { message, _, _ in
            if message["type"] as? String == "send_input",
               let clientId = (message["payload"] as? [String: Any])?["clientId"] as? String { sent.append(clientId) }
            return true
        }
        app.connectionStatus = .connected
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "before background"))
        XCTAssertEqual(sent.count, 1)

        // Background closed the socket before the echo; back on screen.
        app.handleConnectionStateChange(.disconnected)
        XCTAssertEqual(app.connectionStatus, .disconnected)
        app.connectionStatus = .connected
        XCTAssertEqual(sent.count, 2, "the new connection carries it again")
        sender.resendPendingInputs(deviceId: dev, reason: "greeting")
        XCTAssertEqual(sent.count, 2, "the greeting right after must not send a third copy")

        // A Tentacle that itself reconnected may have lost the copy.
        sender.resendPendingInputs(deviceId: dev, reason: "tentacle_online")
        XCTAssertEqual(sent.count, 3)
    }

    func testResendCoalescingExpiresAndForgetsClosedConnections() {
        var clock = Date(timeIntervalSince1970: 1_000)
        var coalescer = ResendCoalescer()
        coalescer.now = { clock }
        coalescer.handedOff("c")
        XCTAssertTrue(coalescer.isRedundant("c", reason: "greeting"))
        XCTAssertFalse(coalescer.isRedundant("c", reason: "local_link_up"))
        clock = clock.addingTimeInterval(ResendCoalescer.window + 0.1)
        XCTAssertFalse(coalescer.isRedundant("c", reason: "greeting"))
        coalescer.handedOff("c")
        coalescer.transportClosed()
        XCTAssertFalse(coalescer.isRedundant("c", reason: "reconnected"))
    }

    // MARK: - (b) keep the socket while an input waits for its echo

    private final class GraceWorld {
        var canKeep = false
        var awaitingEcho = true
        var log: [String] = []
        lazy var grace = BackgroundSocketGrace(hooks: .init(
            canKeep: { [unowned self] in canKeep },
            hasSendsAwaitingEcho: { [unowned self] in awaitingEcho },
            setVisible: { [unowned self] in log.append($0 ? "visible" : "hidden") },
            teardown: { [unowned self] in log.append("teardown") },
            beginTask: { [unowned self] _ in log.append("beginTask"); return 3 },
            endTask: { [unowned self] token in log.append("endTask\(token)") }
        ))
    }

    private func settle(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    /// iPhone diag 10-18/10-20: inputs handed off 0.1–1.8 s before leaving
    /// waited 35 s and 82 s, because the socket closed at once (an older Head
    /// without `app_visibility` cannot take the full grace).
    func testUnconfirmedInputKeepsTheSocketUntilItsEcho() {
        let world = GraceWorld()
        XCTAssertTrue(world.grace.begin(grace: .seconds(5), flushGrace: .seconds(5)))
        XCTAssertEqual(world.log, ["beginTask"], "the Head is not told hidden: it would stop pushing")
        settle(0.4)
        XCTAssertFalse(world.log.contains("teardown"))
        world.awaitingEcho = false
        settle(0.6)
        XCTAssertEqual(world.log, ["beginTask", "teardown", "endTask3"])
    }

    func testFlushOnlyGraceIsBoundedAndResumable() {
        let bounded = GraceWorld()
        XCTAssertTrue(bounded.grace.begin(grace: .seconds(5), flushGrace: .milliseconds(300)))
        settle(0.9)
        XCTAssertEqual(bounded.log, ["beginTask", "teardown", "endTask3"], "never waits for an echo forever")

        let back = GraceWorld()
        XCTAssertTrue(back.grace.begin(grace: .seconds(5), flushGrace: .seconds(5)))
        XCTAssertTrue(back.grace.resume())
        XCTAssertEqual(back.log, ["beginTask", "endTask3"], "nothing was hidden, nothing to unhide")

        let nothing = GraceWorld(); nothing.awaitingEcho = false
        XCTAssertFalse(nothing.grace.begin())
        XCTAssertEqual(nothing.log, [])
    }

    func testOnlySendingInputsToAReachableTentacleHoldTheSocket() throws {
        let app = try makeApp()
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.connectionStatus = .connected
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertFalse(sender.hasSendsAwaitingEcho)
        XCTAssertNotNil(sender.stageInput(sessionId: sid, text: "still correcting"))
        XCTAssertFalse(sender.hasSendsAwaitingEcho, "a correcting voice input has its own background finisher")
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "typed"))
        XCTAssertTrue(sender.hasSendsAwaitingEcho)
    }

    // MARK: - (e) catch-up that adds nothing renderable ends the outage

    /// Mac diag 10-15 18:31 / 10-16 02:04: re-authenticated in ~3 s, yet the
    /// outage read "caught up" only at the next new message (216 s) or never.
    /// The newest seqs were rows clients never store; the tracker compared
    /// the last *stored* row and nothing re-rendered.
    func testHeadReplyWithoutNewRowsEndsTheOutage() throws {
        let app = try makeApp()
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.sessionStore.activeSessionId = sid
        app.connectionStatus = .connected
        let stability = app.stability
        stability.authenticated()
        stability.transportLost(reason: "receive_failed", code: nil, quietFor: 0)
        stability.authenticated()
        app.noteSessionListApplied()
        XCTAssertTrue(stability.outages.isEmpty, "local 0 < head 12: catching up")

        let provider = try XCTUnwrap(app.messageProvider)
        provider.handleBatch(sessionId: sid, messages: [], lastSeq: 12, totalLastSeq: 12, containsHead: true)
        XCTAssertEqual(stability.outages.last?.outcome, .recovered)
        XCTAssertNotNil(stability.outages.last?.catchupMs)
    }

    // MARK: - (d) connect timeout

    /// Mac diag 10-20 01:26: the first connect after a reboot hung the whole
    /// 30 s; the retry opened in 1.1 s.
    func testConnectTimeoutStartsShortAndDoublesToItsCap() {
        let client = WebSocketClient(relayURL: "ws://127.0.0.1:9")
        XCTAssertEqual(client.currentConnectTimeout, 10)
        client.debugSetConsecutiveConnectTimeouts(1)
        XCTAssertEqual(client.currentConnectTimeout, 20)
        client.debugSetConsecutiveConnectTimeouts(4)
        XCTAssertEqual(client.currentConnectTimeout, 30)
    }

    // MARK: - (i) attachment send stages

    func testAttachmentSendReportsHandoffAndUpload() {
        var clock = Date(timeIntervalSince1970: 10)
        let tracker = SendTracker()
        tracker.now = { clock }
        tracker.created("a", kind: .typed, textLength: 3, attachments: 1, pathUp: true, handoffMs: 120)
        tracker.created("t", kind: .typed, textLength: 3, attachments: 0, pathUp: true, handoffMs: 1)
        clock = clock.addingTimeInterval(1)
        tracker.pulseAcked(seqUpTo: 4, lastSentSeq: 9, uploadQueueEmpty: false) // parts still queued
        clock = clock.addingTimeInterval(1)
        tracker.pulseAcked(seqUpTo: 6, lastSentSeq: 9, uploadQueueEmpty: true)  // all sent, through 9
        clock = clock.addingTimeInterval(1.5)
        tracker.pulseAcked(seqUpTo: 9, lastSentSeq: 9, uploadQueueEmpty: true)
        clock = clock.addingTimeInterval(2)
        tracker.finished("a", .delivered)
        tracker.finished("t", .delivered)
        let attachment = tracker.summaries[0]
        XCTAssertEqual(attachment.handoffMs, 120)
        XCTAssertEqual(attachment.uploadMs ?? 0, 3_500, accuracy: 1)
        XCTAssertEqual(attachment.confirmMs ?? 0, 5_500, accuracy: 1)
        XCTAssertNil(tracker.summaries[1].handoffMs, "text sends are not broken down")
        XCTAssertNil(tracker.summaries[1].uploadMs)
    }
}
