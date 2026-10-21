import XCTest
@testable import Kraki_Dev

/// Reconnect latency fixes (diag review 2026-10-21).
@MainActor
final class ReconnectLatencyTests: XCTestCase {
    private func settle(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    private func makeApp() throws -> (AppState, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-rl-\(UUID().uuidString)")
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        return (app, root)
    }

    private func addSession(_ app: AppState, _ sid: String, lastSeq: Int) {
        let dev = "rl-tentacle"
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "d", agent: "pi", model: "m", title: "t",
            state: .idle, mode: .auto, lastSeq: lastSeq, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "d", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
    }

    // MARK: - Chat opened before auth_ok

    /// Diag 10-15 14:35, 10-16 03:30, 10-17 15:17: a Chat opened during the
    /// reconnect reached its newest message exactly 5.0 s after the tap. The
    /// pre-auth head request was dropped by the transport but kept its slot,
    /// so the post-auth session_list self-heal skipped it until the timeout.
    func testChatOpenedBeforeAuthAsksForItsHeadRightAfterAuth() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let sid = "rl-open-before-auth"
        addSession(app, sid, lastSeq: 12)
        var requests: [String] = []
        app.testOutboundMessageHandler = { msg, _, _ in
            if msg["type"] as? String == "request_session_messages" { requests.append(sid) }
            return true
        }
        let provider = try XCTUnwrap(app.messageProvider)

        app.connectionStatus = .authenticating
        provider.ensureLoaded(sessionId: sid, reason: "openSession")
        XCTAssertFalse(provider.isLoadingHead(sid), "no slot reserved for a request that cannot leave")
        XCTAssertEqual(requests.count, 0)

        app.connectionStatus = .connected
        provider.setTentacleInfo(sessionId: sid, lastSeq: 12, deviceId: "rl-tentacle")
        provider.ensureLoaded(sessionId: sid, reason: "sessionListSelfHeal")
        XCTAssertTrue(provider.isLoadingHead(sid))
        XCTAssertEqual(requests.count, 1, "the self-heal asks immediately, not after the 5 s head timeout")
    }

    // MARK: - Auth reply deadline

    func testOnlyReusableCredentialsAreRetriedOnAFreshSocket() {
        func frame(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        XCTAssertTrue(WebSocketClient.isRetryableAuthFrame(frame(["type": "auth", "auth": ["method": "challenge", "deviceId": "d"]])))
        XCTAssertTrue(WebSocketClient.isRetryableAuthFrame(frame(["type": "auth", "auth": ["method": "github_token", "token": "t"]])))
        XCTAssertTrue(WebSocketClient.isRetryableAuthFrame(frame(["type": "auth_response", "deviceId": "d", "signature": "s"])))
        // Single-use: retrying would burn them.
        XCTAssertFalse(WebSocketClient.isRetryableAuthFrame(frame(["type": "auth", "auth": ["method": "pairing", "token": "t"]])))
        XCTAssertFalse(WebSocketClient.isRetryableAuthFrame(frame(["type": "auth", "auth": ["method": "github", "code": "c"]])))
        XCTAssertFalse(WebSocketClient.isRetryableAuthFrame(frame(["type": "auth_info"])))
        XCTAssertFalse(WebSocketClient.isRetryableAuthFrame(frame(["type": "ping"])))
    }

    func testAuthReplyDeadlineDoublesUpToItsCap() {
        let client = WebSocketClient(relayURL: "ws://127.0.0.1:9")
        XCTAssertEqual(client.currentAuthReplyTimeout, 5)
        client.debugSetConsecutiveAuthReplyTimeouts(1)
        XCTAssertEqual(client.currentAuthReplyTimeout, 10)
        client.debugSetConsecutiveAuthReplyTimeouts(5)
        XCTAssertEqual(client.currentAuthReplyTimeout, 20)
    }

    // MARK: - Background socket grace

    private final class GraceWorld {
        var canKeep = true
        var taskGranted = true
        var log: [String] = []
        var expire: (() -> Void)?
        lazy var grace = BackgroundSocketGrace(hooks: .init(
            canKeep: { [unowned self] in canKeep },
            setVisible: { [unowned self] in log.append($0 ? "visible" : "hidden") },
            teardown: { [unowned self] in log.append("teardown") },
            beginTask: { [unowned self] expired in
                guard taskGranted else { return nil }
                expire = expired; log.append("beginTask"); return 7
            },
            endTask: { [unowned self] token in log.append("endTask\(token)") }
        ))
    }

    func testBackAWithinTheGraceKeepsTheSocket() {
        let world = GraceWorld()
        XCTAssertTrue(world.grace.begin(grace: .seconds(5)))
        XCTAssertEqual(world.log, ["beginTask", "hidden"])
        XCTAssertTrue(world.grace.resume())
        XCTAssertEqual(world.log, ["beginTask", "hidden", "visible", "endTask7"])
        settle(0.1)
        XCTAssertFalse(world.log.contains("teardown"))
    }

    func testGraceRunsOutThenClosesLikeABackground() {
        let world = GraceWorld()
        XCTAssertTrue(world.grace.begin(grace: .milliseconds(100)))
        settle(0.4)
        XCTAssertEqual(world.log, ["beginTask", "hidden", "teardown", "endTask7"])
        XCTAssertFalse(world.grace.resume(), "already closed: the caller reconnects")
    }

    func testOSExpiryOrDroppedSocketCloses() {
        let world = GraceWorld()
        XCTAssertTrue(world.grace.begin(grace: .seconds(5)))
        world.expire?()
        settle(0.1)
        XCTAssertEqual(world.log, ["beginTask", "hidden", "teardown", "endTask7"])

        let dropped = GraceWorld()
        XCTAssertTrue(dropped.grace.begin(grace: .seconds(5)))
        dropped.grace.abandon()
        XCTAssertEqual(dropped.log, ["beginTask", "hidden", "teardown", "endTask7"])
    }

    func testFallsBackToImmediateCloseWhenItCannotKeep() {
        let oldHead = GraceWorld(); oldHead.canKeep = false
        XCTAssertFalse(oldHead.grace.begin())
        XCTAssertEqual(oldHead.log, [], "an old Head would stop pushing to a connected app")

        let noTime = GraceWorld(); noTime.taskGranted = false
        XCTAssertFalse(noTime.grace.begin())
        XCTAssertEqual(noTime.log, [])
    }
}
