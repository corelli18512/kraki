import XCTest
@testable import Kraki_Dev

/// Diag iOS 0.1.11, 2026-09-28 10:15:52 and 18:13:16: voice sent (staged,
/// waiting for correction), app backgrounded 1–3 s later →
/// `retireKeepingDraft()` → `failStagedInput`; delivered only when the user
/// tapped Retry 4 and 16 minutes later. AppState now defers that teardown with
/// `BackgroundVoiceFinisher` so the correction can finish first.
@MainActor
final class BackgroundVoiceFinisherTests: XCTestCase {
    /// Design pin (unchanged): a voice input that failed its correction is
    /// never re-sent automatically — which is why it must not fail just
    /// because the app went to the background.
    func testFailedVoiceInputIsOnlySentByManualRetry() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("repro3-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        let app = AppState(testDatabase: db)
        let sid = "repro3", dev = "repro3-dev"
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "d", agent: "pi", model: "m", title: "t",
            state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "d", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        var sent: [String] = []
        app.testOutboundMessageHandler = { msg, _, _ in
            if msg["type"] as? String == "send_input",
               let p = msg["payload"] as? [String: Any], let id = p["clientId"] as? String { sent.append(id) }
            return true
        }
        let sender = try XCTUnwrap(app.commandSender)
        // Voice release: staged bubble, waiting for correction.
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "raw transcript", attachments: nil,
                                                       delivery: .prompt, answerTo: nil))
        XCTAssertTrue(sent.isEmpty, "nothing leaves before correction")
        // App goes to background before correction returns.
        sender.failStagedInput(sessionId: sid, clientId: clientId, text: "raw transcript")
        // Foreground / reconnect / Tentacle-online: every automatic path.
        sender.resendPendingInputs(reason: "authenticated")
        sender.resendPendingInputs(sessionId: sid, reason: "tentacleOnline")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let state = sender.pendingInputs(sid).first.map { sender.pendingState($0) }
        XCTAssertEqual(sent, [], "no automatic path delivers a failed voice input")
        XCTAssertEqual(state, .failed)
        // Only the user's Retry delivers.
        XCTAssertTrue(sender.retryPending(sessionId: sid, clientId: clientId))
        XCTAssertEqual(sent, [clientId])
    }

    // MARK: BackgroundVoiceFinisher

    private final class World {
        var finishing = true, delivered = false
        var log: [String] = []
        var expire: (() -> Void)?
        lazy var finisher = BackgroundVoiceFinisher(hooks: .init(
            isFinishing: { [unowned self] in finishing },
            isDelivered: { [unowned self] in delivered },
            retire: { [unowned self] in log.append("retire") },
            teardown: { [unowned self] in log.append("teardown") },
            beginTask: { [unowned self] in expire = $0; log.append("begin"); return 7 },
            endTask: { [unowned self] in log.append("end\($0)") }))
    }
    private func run(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    func testNothingFinishingTearsDownNow() {
        let w = World(); w.finishing = false
        XCTAssertFalse(w.finisher.beginIfNeeded())
        XCTAssertEqual(w.log, [])
    }

    func testCorrectionFinishesThenDeliveredThenTeardownWithoutRetire() {
        let w = World()
        XCTAssertTrue(w.finisher.beginIfNeeded())
        run(250); XCTAssertEqual(w.log, ["begin"], "sockets kept while correcting")
        w.finishing = false; run(250)
        XCTAssertEqual(w.log, ["begin"], "waits for the echo")
        w.delivered = true; run(250)
        XCTAssertEqual(w.log, ["begin", "teardown", "end7"])
        XCTAssertFalse(w.finisher.isActive)
    }

    func testCorrectionTooSlowFallsBackToNotSent() {
        let w = World()
        XCTAssertTrue(w.finisher.beginIfNeeded(finishBudget: .milliseconds(300)))
        run(700)
        XCTAssertEqual(w.log, ["begin", "retire", "teardown", "end7"])
    }

    func testDeliveryWaitIsBounded() {
        let w = World()
        XCTAssertTrue(w.finisher.beginIfNeeded(deliveryBudget: .milliseconds(300)))
        w.finishing = false; run(700)
        XCTAssertEqual(w.log, ["begin", "teardown", "end7"], "no echo: still torn down, not retired")
    }

    func testOSExpiryRetiresAndTearsDown() {
        let w = World()
        XCTAssertTrue(w.finisher.beginIfNeeded())
        w.expire?(); run(100)
        XCTAssertEqual(w.log, ["begin", "retire", "teardown", "end7"])
    }

    func testForegroundCancelsWithoutTeardown() {
        let w = World()
        XCTAssertTrue(w.finisher.beginIfNeeded())
        w.finisher.cancel(); w.finishing = false; w.delivered = true; run(400)
        XCTAssertEqual(w.log, ["begin", "end7"])
    }
}
