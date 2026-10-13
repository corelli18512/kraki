import XCTest
@testable import Kraki_Dev

/// Version transition end to end: one computer directory switching between the
/// PRE-device-trust Tentacle (origin/main, CHAOS_OLD_WORKTREE) and the new one,
/// with this (new) app and an old-protocol app on the same account.
///   CHAOS_DEVICE_TRUST=default CHAOS_OLD_WORKTREE=… bash scripts/chaos/run-trust.sh \
///     -only-testing:KrakiMacTests/DeviceTrustTransitionTests
@MainActor
final class DeviceTrustTransitionTests: XCTestCase {
    struct StackInfo: Decodable { let controlPort: Int; let appPort: Int; let sessionId: String; let tentacleId: String }

    private var stack: StackInfo!
    private var app: AppState?
    private var keysDir: URL!
    private var suite: String!

    override func setUp() async throws {
        // Isolate identity keys before anything can skip: tearDown resets them.
        keysDir = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-trust-keys-\(UUID().uuidString)")
        DeviceIdentityKeys.testDirectory = keysDir
        DeviceIdentityKeys.shared.reset()
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: "/tmp/kraki-chaos/stack.json")) else { throw XCTSkip("chaos stack not running") }
        stack = try JSONDecoder().decode(StackInfo.self, from: data)
        guard (try await control("GET", "/trust/state"))["mode"] as? String == "default" else { throw XCTSkip("needs CHAOS_DEVICE_TRUST=default") }
        suite = "DeviceTrustTransition.\(UUID().uuidString)"
        TentacleTrustStore.shared.useDefaults(try XCTUnwrap(UserDefaults(suiteName: suite)))
        DeviceTrustTesting.localKrakiHome = FileManager.default.temporaryDirectory.appendingPathComponent("no-local-computer")
        DeviceTrustModel.shared.reset()
    }

    override func tearDown() async throws {
        app?.disconnect()
        app = nil
        if DeviceIdentityKeys.testDirectory != nil { DeviceIdentityKeys.shared.reset() }
        DeviceIdentityKeys.testDirectory = nil
        DeviceTrustTesting.localKrakiHome = nil
        UserDefaults().removePersistentDomain(forName: suite ?? "")
        if let keysDir { try? FileManager.default.removeItem(at: keysDir) }
    }

    // MARK: Helpers

    @discardableResult
    private func control(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(stack.controlPort)\(path)")))
        req.httpMethod = method
        req.timeoutInterval = 60
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let error = object["error"] as? String { throw NSError(domain: "stack", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(path): \(error)"]) }
        return object
    }

    private func waitUntil(_ seconds: TimeInterval, _ what: String, _ check: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !check() {
            if Date() > end { throw NSError(domain: "timeout", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out: \(what)"]) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func received(_ text: String, within seconds: TimeInterval = 15) async throws -> Int {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            let ledger = try await control("GET", "/ledger?sessionId=\(stack.sessionId)")["received"] as? [String: Int] ?? [:]
            if let n = ledger[text] { return n }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < end
        return 0
    }

    private func policy() async throws -> Bool? {
        ((try await control("GET", "/trust/state"))["policyFile"] as? [String: Any])?["enforce"] as? Bool
    }

    /// This (new) app sends one input; true when the agent received it.
    private func appInputArrives(_ app: AppState, _ label: String, within seconds: TimeInterval = 15) async throws -> Bool {
        let text = "new-app-\(label)-\(UUID().uuidString.prefix(6))"
        _ = app.commandSender?.sendInput(sessionId: stack.sessionId, text: text)
        return try await received(text, within: seconds) == 1
    }

    /// An app that predates device trust sends one input.
    private func oldAppInputArrives(_ label: String, within seconds: TimeInterval = 10) async throws -> Bool {
        let text = "old-app-\(label)-\(UUID().uuidString.prefix(6))"
        try await control("POST", "/peer/input", ["text": text])
        return try await received(text, within: seconds) == 1
    }

    private func connect() async throws -> AppState {
        let app = AppState.makeNetworkHarness(relayPort: stack.appPort)
        self.app = app
        try await waitUntil(30, "connected with the session") {
            app.connectionStatus == .connected && app.sessionStore.sessions[self.stack.sessionId] != nil
                && app.deviceStore.devices[self.stack.tentacleId]?.online == true
        }
        return app
    }

    private func waitOnline(_ app: AppState) async throws {
        try await waitUntil(30, "computer online") {
            app.deviceStore.devices[self.stack.tentacleId]?.online == true && app.sessionStore.sessions[self.stack.sessionId] != nil
        }
        try await Task.sleep(nanoseconds: 1_000_000_000)
    }

    // MARK: The whole transition

    func test_oldToNewAndBack() async throws {
        let computer = stack.tentacleId
        // 0. A computer set up with the new Kraki defaults to compatible.
        let fresh = try await policy()
        XCTAssertEqual(fresh, false, "fresh install starts compatible in the transition release")

        // 1. The same computer as it was before device trust (old Kraki).
        try await control("POST", "/transition/stop-new")
        try await control("POST", "/transition/old-install")
        try await control("POST", "/transition/start-old")
        let app = try await connect()
        try await waitUntil(15, "old computer seen as needing an update") { app.trustState(for: computer) == .unsupported }
        var ok = try await appInputArrives(app, "old-cli")
        XCTAssertTrue(ok, "new app ⇄ old CLI")
        ok = try await oldAppInputArrives("old-cli")
        XCTAssertTrue(ok, "old app ⇄ old CLI")

        // 2. Upgrade the computer: nothing to do, everything keeps working.
        try await control("POST", "/transition/stop-old")
        try await control("POST", "/transition/start-new")
        let upgraded = try await policy()
        XCTAssertEqual(upgraded, false, "upgraded install stays compatible")
        try await waitOnline(app)
        try await waitUntil(15, "upgraded computer offers pairing") { app.trustState(for: computer) == .notPaired }
        ok = try await appInputArrives(app, "upgraded-unpaired")
        XCTAssertTrue(ok, "new app (not yet paired) ⇄ upgraded CLI")
        ok = try await oldAppInputArrives("upgraded")
        XCTAssertTrue(ok, "old app ⇄ upgraded CLI")

        // 3. Pair the new app (QR). The old app keeps working (compatible).
        let linkURL = try await control("POST", "/trust/pairing-link")["url"] as? String
        let link = try XCTUnwrap(PairingLink(string: try XCTUnwrap(linkURL)))
        app.pairWithComputer(link)
        try await waitUntil(20, "paired") { app.trustState(for: computer) == .paired }
        ok = try await appInputArrives(app, "paired")
        XCTAssertTrue(ok, "paired new app ⇄ new CLI")
        ok = try await oldAppInputArrives("paired-compatible")
        XCTAssertTrue(ok, "old app still works while compatible")

        // 4. The user turns on "Only paired devices": old apps are cut off.
        try await waitUntil(15, "trust info") { app.deviceTrust.info[computer] != nil }
        app.setOnlyPairedDevices(true, on: computer)
        try await waitUntil(20, "enforcement confirmed") { app.deviceTrust.info[computer]?.enforced == true }
        ok = try await oldAppInputArrives("enforced", within: 3)
        XCTAssertFalse(ok, "old app refused once enforced")
        ok = try await appInputArrives(app, "enforced")
        XCTAssertTrue(ok, "paired new app works when enforced")

        // 5. Downgrade the computer to the old Kraki.
        try await control("POST", "/transition/stop-new")
        try await control("POST", "/transition/start-old")
        try await waitOnline(app)
        try await waitUntil(30, "app notices the computer stopped signing") { app.trustState(for: computer) == .stoppedSigning }
        XCTAssertFalse(app.computersNeedingPairing.isEmpty, "banner offers Forget Pairing")
        ok = try await appInputArrives(app, "downgraded-pinned", within: 3)
        XCTAssertFalse(ok, "still pinned: the old CLI cannot read signed X25519 input")
        app.forgetPairing(computer)
        ok = try await appInputArrives(app, "downgraded-forgotten")
        XCTAssertTrue(ok, "after Forget Pairing the new app works with the old CLI")
        ok = try await oldAppInputArrives("downgraded")
        XCTAssertTrue(ok, "old app works with the old CLI")

        // 6. Upgrade again: the user's earlier choice (enforce) is kept.
        try await control("POST", "/transition/stop-old")
        try await control("POST", "/transition/start-new")
        let kept = try await policy()
        XCTAssertEqual(kept, true, "policy survives downgrade/upgrade")
        try await waitOnline(app)
        ok = try await oldAppInputArrives("re-upgraded", within: 3)
        XCTAssertFalse(ok)
        // Scanning again restores the pairing.
        let againURL = try await control("POST", "/trust/pairing-link")["url"] as? String
        let again = try XCTUnwrap(PairingLink(string: try XCTUnwrap(againURL)))
        app.pairWithComputer(again)
        try await waitUntil(20, "paired again") { app.trustState(for: computer) == .paired }
        ok = try await appInputArrives(app, "re-paired")
        XCTAssertTrue(ok)
    }
}
