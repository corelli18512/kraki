import XCTest
@testable import Kraki_Dev

/// Hardware-free ordering and mixed-version probes for PR #577.
@MainActor
final class ReconnectAdversarialTests: XCTestCase {
    private final class World {
        var canKeep = true
        var nextToken = 0
        var ended: [Int] = []
        var expirations: [() -> Void] = []
        var visibility: [Bool] = []
        var teardowns = 0
        lazy var grace = BackgroundSocketGrace(hooks: .init(
            canKeep: { [unowned self] in canKeep },
            setVisible: { [unowned self] in visibility.append($0) },
            teardown: { [unowned self] in teardowns += 1 },
            beginTask: { [unowned self] expiration in
                nextToken += 1; expirations.append(expiration); return nextToken
            },
            endTask: { [unowned self] in ended.append($0) }
        ))
    }

    func testRepeatedBackgroundDoesNotLeakTheFirstOSTask() {
        let world = World()
        XCTAssertTrue(world.grace.begin())
        XCTAssertTrue(world.grace.begin())
        world.grace.abandon()
        XCTAssertEqual(Set(world.ended), Set(1...world.nextToken), "every granted task must be ended, even for duplicate background notifications")
        XCTAssertEqual(world.ended.count, Set(world.ended).count)
    }

    func testOldExpirationCannotTearDownANewerGrace() {
        let world = World()
        XCTAssertTrue(world.grace.begin())
        let oldExpiration = world.expirations[0]
        XCTAssertTrue(world.grace.resume())
        XCTAssertTrue(world.grace.begin())
        oldExpiration()
        XCTAssertTrue(world.grace.isActive, "expiry belongs to the old task, not the new background visit")
        XCTAssertEqual(world.teardowns, 0)
        world.grace.abandon()
    }

    func testResumeAndAbandonAreIdempotent() {
        let world = World()
        XCTAssertTrue(world.grace.begin())
        XCTAssertTrue(world.grace.resume())
        XCTAssertFalse(world.grace.resume())
        world.grace.abandon()
        world.expirations[0]()
        XCTAssertEqual(world.visibility, [false, true])
        XCTAssertEqual(world.ended, [1])
        XCTAssertEqual(world.teardowns, 0)
    }

    func testOldHeadClearsFeaturesFromPreviousHead() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-qa-features-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.applyRelayCapabilities(["features": ["app_visibility"]])
        XCTAssertTrue(app.relayFeatures.contains("app_visibility"))
        app.applyRelayCapabilities([:])
        XCTAssertTrue(app.relayFeatures.isEmpty, "no features means old Head, not previous Head's capabilities")
    }

    func testEmptyDeltaClearsHeadSlotAndSyncingWithoutInventingRows() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-qa-delta-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        let sid = "qa-empty-delta"
        app.sessionStore.sessions[sid] = SessionInfo(id: sid, deviceId: "d", deviceName: "d", agent: "pi", model: "m", title: "t", state: .idle, mode: .auto, lastSeq: 9, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices["d"] = DeviceSummary(id: "d", name: "d", role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        let rows = (1...7).map { ChatMessage(type: "agent_message", seq: $0, sessionId: sid, deviceId: "d", timestamp: nil, payload: ["content": AnyCodable("row")]) }
        app.messageStore.ingestBatch(sid, rows)
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        let provider = try XCTUnwrap(app.messageProvider)
        provider.setTentacleInfo(sessionId: sid, lastSeq: 9, deviceId: "d")
        provider.ensureLoaded(sessionId: sid, reason: "qa")
        XCTAssertTrue(provider.isLoadingHead(sid))
        // Legacy 8/9 are off-spine; the Tentacle has no missing spine rows.
        provider.handleBatch(sessionId: sid, messages: [], lastSeq: 9, totalLastSeq: 9, containsHead: true)
        XCTAssertFalse(provider.isLoadingHead(sid))
        XCTAssertFalse(provider.isFillingTail(sid))
        XCTAssertEqual(app.messageStore.persistedHead(sid), 9)
        XCTAssertEqual(app.messageStore.dbLastSeq(sid), 7)
        XCTAssertTrue(provider.outstandingKinds(sid).isEmpty)
        // Repeated view appearance/self-heal after an empty delta must not
        // start the same request again just because off-spine rows aren't in SQLite.
        provider.ensureLoaded(sessionId: sid, reason: "qa-after-empty-delta")
        XCTAssertFalse(provider.isLoadingHead(sid), "the acknowledged head, not SQLite's highest spine row, must gate future requests")
    }

    func testLaunchCredentialResolutionAlsoBlocksEarlyForegroundConnect() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-qa-launch-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.relayURL = "ws://127.0.0.1:9"
        app.setupNetworking(outboxURL: root.appendingPathComponent("outbox.json"))
        defer { app.disconnect() }
        app.authManager?.useEphemeralKeysForCurrentProcess()
        app.authManager?.debugIsolatedIdentity = true
        app.authManager?.debugSetStoredDeviceId("qa-stored-device")
        app.hasCompletedInitialConnect = false
        app.launchResolvingCredentials = true
        app.isInBackground = true
        app.startForegroundConnectEarly()
        XCTAssertEqual(app.wsClient?.state, .disconnected, "inactive must honor the same launch credential barrier as active")
    }
}
