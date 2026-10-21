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
