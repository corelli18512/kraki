import XCTest
@testable import Kraki_Dev

/// Device trust end to end: the production Swift networking against the
/// isolated chaos stack (real Head + Tentacle) with the Tentacle enforcing
/// device trust (`CHAOS_DEVICE_TRUST=enforce bash scripts/chaos/run-trust.sh`).
@MainActor
final class DeviceTrustE2ETests: XCTestCase {
    struct StackInfo: Decodable { let controlPort: Int; let appPort: Int; let app2Port: Int; let sessionId: String; let tentacleId: String }

    private var stack: StackInfo!
    private var app: AppState?
    private var keysDir: URL!
    private var defaultsSuite: String!

    override func setUp() async throws {
        let url = URL(fileURLWithPath: "/tmp/kraki-chaos/stack.json")
        guard let data = try? Data(contentsOf: url) else { throw XCTSkip("chaos stack not running") }
        stack = try JSONDecoder().decode(StackInfo.self, from: data)
        let state = try await control("GET", "/trust/state")
        guard state["mode"] as? String == "enforce" else { throw XCTSkip("stack does not enforce device trust") }
        // A fresh install: new identity keys, no pins.
        keysDir = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-trust-keys-\(UUID().uuidString)")
        DeviceIdentityKeys.testDirectory = keysDir
        DeviceIdentityKeys.shared.reset()
        defaultsSuite = "DeviceTrustE2E.\(UUID().uuidString)"
        TentacleTrustStore.shared.useDefaults(UserDefaults(suiteName: defaultsSuite)!)
        DeviceTrustTesting.localKrakiHome = FileManager.default.temporaryDirectory.appendingPathComponent("no-local-computer")
        DeviceTrustCoordinator.shared.lastPairRequest = [:]
    }

    override func tearDown() async throws {
        app?.disconnect()
        app = nil
        DeviceIdentityKeys.shared.reset()
        DeviceIdentityKeys.testDirectory = nil
        DeviceTrustTesting.localKrakiHome = nil
        UserDefaults().removePersistentDomain(forName: defaultsSuite ?? "")
        if let keysDir { try? FileManager.default.removeItem(at: keysDir) }
    }

    // MARK: Helpers

    @discardableResult
    private func control(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(stack.controlPort)\(path)")!)
        req.httpMethod = method
        req.timeoutInterval = 30
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func waitUntil(_ seconds: TimeInterval, _ what: String, _ check: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !check() {
            if Date() > end { throw NSError(domain: "timeout", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out: \(what)"]) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func pause(_ seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private func received() async throws -> [String: Int] {
        (try await control("GET", "/ledger?sessionId=\(stack.sessionId)"))["received"] as? [String: Int] ?? [:]
    }

    private func agentMessages(_ app: AppState) -> [String] {
        app.messageDatabase.messagesAfter(stack.sessionId, afterSeq: 0, limit: 10_000)
            .filter { $0.type == "agent_message" }.compactMap(\.content)
    }

    private func connect(port: Int) async throws -> AppState {
        let app = AppState.makeNetworkHarness(relayPort: port)
        self.app = app
        try await waitUntil(20, "connected, computer online") {
            app.connectionStatus == .connected && app.deviceStore.devices[self.stack.tentacleId]?.online == true
        }
        return app
    }

    /// Paired: the session is served and a command round-trips; an unpaired
    /// device on the account cannot command the computer.
    private func assertWorksAndRogueIsRefused(_ app: AppState) async throws {
        try await waitUntil(20, "session served after pairing") { app.sessionStore.sessions[self.stack.sessionId] != nil }
        app.sessionSubscriptionController.setDesired(stack.sessionId)
        _ = app.messageProvider?.openSession(stack.sessionId)
        try await waitUntil(10, "subscription confirmed") { app.sessionSubscriptionController.liveReady }

        let text = "trusted-\(UUID().uuidString.prefix(6))"
        XCTAssertTrue(app.commandSender?.sendInput(sessionId: stack.sessionId, text: text) ?? false)
        let deadline = Date().addingTimeInterval(15)
        var ledger = try await received()
        while ledger[text] == nil, Date() < deadline {
            await pause(0.2)
            ledger = try await received()
        }
        XCTAssertEqual(ledger[text], 1, "the agent received the paired app's input exactly once")
        try await waitUntil(15, "agent reply reached the app") { !self.agentMessages(app).isEmpty }

        let rogueText = "rogue-\(UUID().uuidString.prefix(6))"
        try await control("POST", "/trust/rogue-input", ["text": rogueText])
        await pause(2)
        let afterRogue = try await received()
        XCTAssertNil(afterRogue[rogueText], "an unpaired device must not command the computer")
        let stats = (try await control("GET", "/trust/state"))["stats"] as? [String: Int] ?? [:]
        XCTAssertGreaterThan(stats["signedIn"] ?? 0, 0)
        XCTAssertGreaterThan(stats["rejected"] ?? 0, 0)
    }

    // MARK: Scenarios

    /// Scan the computer's QR code: the app pins its keys, proves the secret,
    /// and only then is served.
    func test_T1_qrPairing() async throws {
        let app = try await connect(port: stack.appPort)
        // Signed in to the account, but not paired: the computer serves nothing.
        await pause(2)
        XCTAssertNil(app.sessionStore.sessions[stack.sessionId], "an unpaired app gets no sessions")

        let url = try await control("POST", "/trust/pairing-link")["url"] as? String ?? ""
        let link = try XCTUnwrap(PairingLink(string: url))
        XCTAssertNotNil(link.trust)
        app.pairWithComputer(link)
        try await waitUntil(15, "paired") { TentacleTrustStore.shared.pairedPin(self.stack.tentacleId) != nil }
        XCTAssertEqual(TentacleTrustStore.shared.pin(stack.tentacleId)?.enforced, true)
        XCTAssertNil(TentacleTrustStore.shared.pin(stack.tentacleId)?.secret, "the one-time secret is dropped")
        try await assertWorksAndRogueIsRefused(app)
    }

    /// A pairing secret works once: a second app reusing the same QR is refused.
    func test_T2_qrSecretIsOneTime() async throws {
        let url = try await control("POST", "/trust/pairing-link")["url"] as? String ?? ""
        let first = try await connect(port: stack.appPort)
        first.pairWithComputer(try XCTUnwrap(PairingLink(string: url)))
        try await waitUntil(15, "first app paired") { TentacleTrustStore.shared.pairedPin(self.stack.tentacleId) != nil }
        first.disconnect()

        // Another install (new keys, no pins) scans the same QR.
        DeviceIdentityKeys.shared.reset()
        TentacleTrustStore.shared.reset()
        DeviceTrustCoordinator.shared.lastPairRequest = [:]
        let second = try await connect(port: stack.app2Port)
        second.pairWithComputer(try XCTUnwrap(PairingLink(string: url)))
        try await waitUntil(15, "second app refused") { TentacleTrustStore.shared.pin(self.stack.tentacleId)?.lastError != nil }
        XCTAssertNil(TentacleTrustStore.shared.pairedPin(stack.tentacleId))
        XCTAssertEqual(TentacleTrustStore.shared.pin(stack.tentacleId)?.lastError, "bad_proof")
        await pause(1)
        XCTAssertNil(second.sessionStore.sessions[stack.sessionId])
    }

    /// Kraki for Mac and the computer on the same Mac pair without a QR,
    /// through files only this user can write.
    func test_T3_sameMacPairing() async throws {
        let root = try await control("GET", "/trust/state")["root"] as? String ?? ""
        DeviceTrustTesting.localKrakiHome = URL(fileURLWithPath: root, isDirectory: true)
        let app = try await connect(port: stack.appPort)
        try await waitUntil(15, "paired with this Mac's computer") {
            TentacleTrustStore.shared.pairedPin(self.stack.tentacleId)?.via == "local"
        }
        try await assertWorksAndRogueIsRefused(app)
    }
}
