import Network
import XCTest
@testable import Kraki_Dev

/// Minimal relay: speaks just enough of the auth handshake to replay the
/// 2026-09-30 incident (after a macOS update the stored Keychain challenge
/// failed or stalled, and `gh` answered only after the launch probe gave up),
/// and to act as an edge Head that verifies a known device's challenge itself.
@MainActor
private final class FakeRelay {
    /// `.fatal`: device_not_found. `.hang`: the link stalls (no reply, no
    /// pong). `.verify`: a real challenge, verified against the key the device
    /// last registered (`registeredKeys`), `invalid_signature` otherwise.
    enum ChallengeMode { case fatal, hang, verify }

    private let listener: NWListener
    private var connections: [NWConnection] = []
    /// Connections that stopped answering anything, pings included.
    private var stalled: [ObjectIdentifier] = []
    private var nonces: [ObjectIdentifier: (deviceId: String, nonce: String)] = [:]
    var challengeMode: ChallengeMode = .fatal
    /// Token auths whose link stalls (no reply, no pong: a half-open socket).
    var stalledTokenAuths = 0
    /// Token auths are answered this late (the link keeps answering pings).
    var tokenReplyDelay: TimeInterval = 0
    /// Signing key (SPKI) each device last registered with a token sign-in.
    var registeredKeys: [String: String] = [:]
    private(set) var methods: [String] = []
    /// `device.publicKey` sent with each `auth`.
    private(set) var sentKeys: [String?] = []
    private(set) var verifiedChallenges = 0
    private(set) var port: UInt16 = 0

    init() throws {
        let parameters = NWParameters.tcp
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = false
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        listener = try NWListener(using: parameters, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
    }

    var url: String { "ws://127.0.0.1:\(port)" }

    func start() async throws {
        listener.start(queue: .main)
        let end = Date().addingTimeInterval(5)
        while listener.port == nil || listener.state != .ready {
            if Date() > end { throw XCTSkip("fake relay did not start") }
            try await Task.sleep(for: .milliseconds(20))
        }
        port = listener.port!.rawValue
    }

    func stop() {
        connections.forEach { $0.cancel() }
        listener.cancel()
    }

    private func accept(_ connection: NWConnection) {
        connections.append(connection)
        connection.start(queue: .main)
        receive(connection)
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            MainActor.assumeIsolated {
                guard let self, error == nil else { return }
                let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                if metadata?.opcode == .ping {
                    if !self.stalled.contains(ObjectIdentifier(connection)) { self.pong(data, on: connection) }
                } else if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.handle(json, on: connection)
                }
                self.receive(connection)
            }
        }
    }

    private func handle(_ message: [String: Any], on connection: NWConnection) {
        guard !stalled.contains(ObjectIdentifier(connection)) else { return }
        switch message["type"] as? String {
        case "auth_info":
            send(["type": "auth_info_response", "methods": ["github_token"], "githubClientId": "test"], on: connection)
        case "auth":
            let method = (message["auth"] as? [String: Any])?["method"] as? String ?? "?"
            let device = message["device"] as? [String: Any] ?? [:]
            methods.append(method)
            sentKeys.append(device["publicKey"] as? String)
            switch method {
            case "challenge":
                handleChallenge(message, on: connection)
            case "github_token":
                if stalledTokenAuths > 0 { stalledTokenAuths -= 1; stalled.append(ObjectIdentifier(connection)); return }
                let token = (message["auth"] as? [String: Any])?["token"] as? String
                guard token == "tok-ok" else {
                    send(["type": "auth_error", "code": "auth_rejected", "message": "bad token"], on: connection)
                    return
                }
                let deviceId = device["deviceId"] as? String ?? "dev_recovered"
                registeredKeys[deviceId] = device["publicKey"] as? String
                let ok: [String: Any] = ["type": "auth_ok", "deviceId": deviceId,
                                         "user": ["id": "1", "login": "tester"], "devices": []]
                if tokenReplyDelay > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + tokenReplyDelay) { [weak self] in
                        self?.send(ok, on: connection)
                    }
                } else {
                    send(ok, on: connection)
                }
            default:
                send(["type": "auth_error", "code": "auth_rejected", "message": "unsupported"], on: connection)
            }
        case "auth_response":
            guard let pending = nonces.removeValue(forKey: ObjectIdentifier(connection)),
                  let signature = message["signature"] as? String,
                  let spki = registeredKeys[pending.deviceId],
                  let key = try? CryptoManager().importPublicKeyFromSPKI(spki),
                  CryptoManager().verifyChallenge(pending.nonce, signature: signature, publicKey: key) else {
                send(["type": "auth_error", "code": "invalid_signature", "message": "Invalid signature"], on: connection)
                return
            }
            verifiedChallenges += 1
            send(["type": "auth_ok", "deviceId": pending.deviceId,
                  "user": ["id": "1", "login": "tester"], "devices": []], on: connection)
        default:
            break
        }
    }

    private func handleChallenge(_ message: [String: Any], on connection: NWConnection) {
        switch challengeMode {
        case .fatal:
            send(["type": "auth_error", "code": "device_not_found", "message": "Unknown device"], on: connection)
        case .hang:
            stalled.append(ObjectIdentifier(connection))
        case .verify:
            let deviceId = (message["auth"] as? [String: Any])?["deviceId"] as? String ?? ""
            guard registeredKeys[deviceId] != nil else {
                send(["type": "auth_error", "code": "unknown_device", "message": "Unknown device"], on: connection)
                return
            }
            let nonce = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
            nonces[ObjectIdentifier(connection)] = (deviceId, nonce)
            send(["type": "auth_challenge", "nonce": nonce], on: connection)
        }
    }

    private func pong(_ data: Data?, on connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .pong)
        let context = NWConnection.ContentContext(identifier: "pong", metadata: [metadata])
        connection.send(content: data ?? Data(), contentContext: context, isComplete: true, completion: .idempotent)
    }

    private func send(_ object: [String: Any], on connection: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
    }
}

@MainActor
final class MacAuthRecoveryTests: XCTestCase {
    private var relay: FakeRelay!
    private var app: AppState!
    private var loaderCalls: [TimeInterval] = []

    override func setUp() async throws {
        relay = try FakeRelay()
        try await relay.start()
        loaderCalls = []
    }

    override func tearDown() async throws {
        AuthManager.debugCLICredentialLoader = nil
        AuthManager.debugCLISignInDate = nil
        app?.disconnect()
        app = nil
        relay?.stop()
        relay = nil
        KeychainManager.debugStoredKeysUnusable = false
        KeychainManager.debugResetProcessKeys()
        if let keys = DevSecretFileStore.testDirectory {
            try? FileManager.default.removeItem(at: keys)
            DevSecretFileStore.testDirectory = nil
        }
    }

    /// App graph for a fresh launch against the relay under test. Identity
    /// stays in memory; nothing persists.
    private func makeGraph() throws -> AppState {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-auth-recovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.relayURL = relay.url
        app.hasCompletedInitialConnect = false   // a fresh launch
        app.setupNetworking(outboxURL: root.appendingPathComponent("outbox.json"))
        app.authManager?.debugIsolatedIdentity = true
        return app
    }

    /// App graph as a returning Mac user: a stored (Keychain) device and the
    /// relay under test, on process-local keys (the 2026-09-30 incident).
    private func makeApp() throws -> AppState {
        let app = try makeGraph()
        app.authManager?.useEphemeralKeysForCurrentProcess()
        app.authManager?.debugSetStoredDeviceId("dev_stored")
        app.authWatchdogInterval = 0.2
        app.authStuckThreshold = 1
        return app
    }

    /// `gh` misses the 0.5 s launch probe, answers a later, longer probe.
    private func installSlowGh(answerAfterCalls: Int = 1, delay: Duration = .milliseconds(0)) {
        let url = relay.url
        AuthManager.debugCLICredentialLoader = { [weak self] deadline in
            let call = await MainActor.run { () -> Int in
                self?.loaderCalls.append(deadline)
                return self?.loaderCalls.count ?? 0
            }
            try? await Task.sleep(for: delay)
            guard call > answerAfterCalls, deadline > AuthManager.launchGhDeadline else { return nil }
            return (url, "tok-ok")
        }
    }

    private func waitUntil(_ seconds: TimeInterval, _ what: String, _ check: () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !check() {
            if Date() > end { XCTFail("timed out: \(what)"); return }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    /// Sign Out on the Mac: the built-in Kraki keeps its login, so the app
    /// must stay signed out (no launch login, no watchdog recovery) until the
    /// person signs in again. Previously the window sat on "Connecting to
    /// Kraki…" and the next launch silently signed back in.
    func testSignOutStaysSignedOutUntilSignedInAgain() async throws {
        relay.challengeMode = .fatal
        AuthManager.debugCLICredentialLoader = { [url = relay.url] _ in (url, "tok-ok") }
        app = try makeApp()
        app.authManager?.debugSetStoredDeviceId(nil)
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        let attempts = relay.methods.count

        app.logout()
        XCTAssertTrue(app.signedOutByUser)
        XCTAssertEqual(app.connectionStatus, .awaitingLogin)
        let reused = await app.attemptCLILogin()
        XCTAssertFalse(reused, "relaunch must not reuse the built-in login")
        await app.recoverCLIAuthentication(reason: "test")
        try await Task.sleep(for: .seconds(2))   // watchdog ticks every 0.2 s
        XCTAssertEqual(app.connectionStatus, .awaitingLogin)
        XCTAssertNil(app.user)
        XCTAssertEqual(relay.methods.count, attempts, "nothing signed in behind the person's back")

        // A sign-in the local Kraki saved before the Sign Out changes nothing.
        AuthManager.debugCLISignInDate = { Date().addingTimeInterval(-3600) }
        XCTAssertTrue(app.staysSignedOut)

        // `kraki connect` in Terminal afterwards is signing in again: returning
        // to Kraki (an automatic retry) signs in by itself.
        AuthManager.debugCLISignInDate = { Date().addingTimeInterval(60) }
        let again = await app.attemptCLILogin()
        XCTAssertTrue(again)
        try await waitUntil(10, "signed in again") { app.connectionStatus == .connected }
        XCTAssertFalse(app.signedOutByUser)
    }

    /// Launch probe times out, the stored challenge is rejected as fatal:
    /// previously the window fell to signed-out (or stayed on the main page,
    /// never signed in). Now it signs in with the CLI token by itself.
    func testFatalStoredChallengeRecoversWithLateCLIToken() async throws {
        relay.challengeMode = .fatal
        installSlowGh(delay: .milliseconds(800))
        app = try makeApp()
        let usedCLI = await app.attemptCLILogin()
        XCTAssertFalse(usedCLI, "fixture: the launch probe misses gh")
        app.connect()
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods.first, "challenge")
        XCTAssertEqual(relay.methods.last, "github_token")
        XCTAssertTrue(app.hasStoredCredentials, "the recovered identity keeps the window signed in")
        XCTAssertEqual(loaderCalls.first, AuthManager.launchGhDeadline)
        XCTAssertTrue(loaderCalls.dropFirst().allSatisfy { $0 == AuthManager.recoveryGhDeadline },
                      "recovery gives gh a realistic deadline")
    }

    /// The stored challenge never gets an answer and gh stays slow through
    /// the first background probe: the watchdog keeps retrying and signs in
    /// once gh answers, replacing the still-open unauthenticated socket.
    func testStalledSignInIsRetriedAutomatically() async throws {
        relay.challengeMode = .hang
        installSlowGh(answerAfterCalls: 2)
        app = try makeApp()
        _ = await app.attemptCLILogin()
        app.connect()
        try await waitUntil(15, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods.first, "challenge")
        XCTAssertEqual(relay.methods.last, "github_token")
        XCTAssertGreaterThanOrEqual(loaderCalls.count, 3, "kept looking for the CLI login")
    }

    /// Returning to the window finds the CLI token while the socket is open
    /// but unauthenticated: it must sign in on a replacement socket
    /// (previously connect() was a no-op and the token was never sent).
    func testTokenFoundWhileSocketOpenIsUsed() async throws {
        relay.challengeMode = .hang
        AuthManager.debugCLICredentialLoader = { _ in nil }
        app = try makeApp()
        app.authWatchdogInterval = 60
        _ = await app.attemptCLILogin()
        app.connect()
        try await waitUntil(5, "challenge sent") { relay.methods == ["challenge"] }
        XCTAssertNotEqual(app.connectionStatus, .connected)
        let url = relay.url
        AuthManager.debugCLICredentialLoader = { _ in (url, "tok-ok") }
        let used = await app.attemptCLILogin()
        XCTAssertTrue(used)
        try await waitUntil(5, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["challenge", "github_token"])
    }

    /// Diag 10-19 (27.9 s) / 10-18 (15.9 s): an open socket that never
    /// answers the sign-in was only replaced by the 22 s liveness ping. Now a
    /// retryable auth on a link that does not answer a ping either gets a
    /// fresh socket after `authReplyTimeout` plus the ping's window.
    func testUnansweredSignInIsRetriedOnAFreshSocketWithinSeconds() async throws {
        relay.stalledTokenAuths = 1
        AuthManager.debugCLICredentialLoader = { [url = relay.url] _ in (url, "tok-ok") }
        app = try makeApp()
        app.authManager?.debugSetStoredDeviceId(nil)
        app.authWatchdogInterval = 60
        let started = Date()
        _ = await app.attemptCLILogin()
        try await waitUntil(12, "signed in") { app.connectionStatus == .connected }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertEqual(relay.methods, ["github_token", "github_token"])
        XCTAssertTrue(app.wsClient?.recoveryReasons.contains("auth_reply_timeout") == true)
        XCTAssertGreaterThanOrEqual(elapsed, WebSocketClient.authReplyTimeout - 0.5)
        XCTAssertLessThan(elapsed, WebSocketClient.authReplyTimeout + WebSocketClient.authReplyProbeTimeout + 3,
                          "not the 22 s liveness ping")
        XCTAssertEqual(app.wsClient?.consecutiveAuthReplyTimeouts, 0, "reset once signed in")
    }

    /// While the first sign-in is pending the window says so; it never says
    /// every device is offline.
    func testFirstSignInShowsNoticeAndUnknownPresence() async throws {
        relay.challengeMode = .hang
        AuthManager.debugCLICredentialLoader = { _ in nil }
        app = try makeApp()
        app.authWatchdogInterval = 60
        app.connect()
        try await waitUntil(5, "challenge sent") { relay.methods == ["challenge"] }
        try await waitUntil(4, "notice shown") { app.connectionNotice != nil }
        XCTAssertEqual(app.connectionNotice, "Signing in…")

        let session = SessionInfo(id: "s1", deviceId: "d1", deviceName: "Mac", agent: "pi", model: "m",
                                  title: "t", state: .idle, mode: .auto, lastSeq: 1, readSeq: 1,
                                  messageCount: 1, createdAt: Date(), pinned: false)
        let device = DeviceSummary(id: "d1", name: "Mac", role: .tentacle, kind: .desktop, publicKey: nil,
                                   encryptionKey: nil, online: false, lastSeen: nil, createdAt: nil)
        let unknown = SessionCardProjection.make(session: session, device: device, preview: nil, draft: nil,
                                                 presenceKnown: false)
        XCTAssertNotEqual(unknown.status, .offline)
        XCTAssertNil(unknown.deviceOnline)
        let known = SessionCardProjection.make(session: session, device: device, preview: nil, draft: nil)
        XCTAssertEqual(known.status, .offline, "after sign-in real presence is shown")
    }

    // MARK: Stored-device sign-in (the Mac signs in like the iPhone)

    /// This process's stored keys, in a test directory (Debug keeps them in
    /// files, DevSecretFileStore). `create`: they exist already (a returning
    /// Mac). Returns the signing key's SPKI, or nil when not created.
    @discardableResult
    private func useTestStoredKeys(create: Bool = true) throws -> String? {
        DevSecretFileStore.testDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-stored-keys-\(UUID().uuidString)", isDirectory: true)
        KeychainManager.debugResetProcessKeys()
        guard create else { return nil }
        let spki = try storedSigningKey()
        KeychainManager.debugResetProcessKeys()   // the launch proves them itself
        return spki
    }

    private func storedSigningKey() throws -> String {
        XCTAssertTrue(KeychainManager().useStoredKeysIfUsable())
        return try CryptoManager().exportPublicKeySPKI(KeychainManager().getOrCreateSigningKey().publicKey)
    }

    /// A returning Mac: device `dev_mac` registered its stored keys with a
    /// token sign-in at `registeredAt`; the local Kraki signed in at `cliSignIn`.
    private func makeReturningMac(registeredAt: Date? = Date().addingTimeInterval(-60),
                                  cliSignIn: Date = Date().addingTimeInterval(-3600)) throws -> AppState {
        AuthManager.debugCLICredentialLoader = { [url = relay.url] _ in (url, "tok-ok") }
        AuthManager.debugCLISignInDate = { cliSignIn }
        let app = try makeGraph()
        app.authManager?.debugSetStoredDeviceId("dev_mac")
        app.authManager?.debugSetCredentialSignInAt(registeredAt)
        app.authWatchdogInterval = 60
        return app
    }

    /// (a) A returning Mac whose Keychain keys work without UI signs in with
    /// its challenge, which an edge Head verifies itself, instead of a token
    /// sign-in with new process-local keys that only the account service on
    /// the US main Head could answer (6.8 s p50 from Beijing, 19 s on 11-27).
    func testReturningMacSignsInWithItsStoredDeviceNotTheToken() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        let registeredAt = app.authManager?.credentialSignInAt
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["challenge"])
        XCTAssertEqual(relay.verifiedChallenges, 1)
        XCTAssertEqual(relay.sentKeys, [storedKey])
        XCTAssertFalse(KeychainManager().usingEphemeralKeys, "no process-local keys")
        XCTAssertEqual(app.deviceId, "dev_mac")
        XCTAssertEqual(app.authManager?.cliGitHubToken, "tok-ok", "the token stays loaded for recovery")
        XCTAssertEqual(app.authManager?.credentialSignInAt, registeredAt, "a challenge does not move the account-switch mark")
    }

    /// (b) Keys that would need Keychain UI or were denied: the token signs in
    /// with process-local keys as before, and the next launch uses it again.
    func testUnusableKeychainKeysSignInWithTheTokenAndProcessLocalKeys() async throws {
        let storedKey = try useTestStoredKeys()
        KeychainManager.debugStoredKeysUnusable = true
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertTrue(KeychainManager().usingEphemeralKeys)
        XCTAssertNotEqual(relay.sentKeys.first ?? nil, storedKey)
        XCTAssertNil(app.authManager?.credentialSignInAt, "process-local keys die with the process")
    }

    /// Stored device refused by the relay: the CLI token signs in by itself,
    /// on the same device id, keeping this Mac's data, showing no error, and
    /// registering the stored keys again for the next launch.
    private func assertQuietFallbackToTheToken(storedKey: String?, line: UInt = #line) async throws {
        app = try makeReturningMac()
        app.sessionStore.setDraft("s1", "half a thought")
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn, line: line)
        var sawError = false
        try await waitUntil(10, "signed in") {
            sawError = sawError || app.lastError != nil
            return app.connectionStatus == .connected
        }
        XCTAssertEqual(relay.methods, ["challenge", "github_token"], line: line)
        XCTAssertFalse(sawError, "no error flash", line: line)
        XCTAssertEqual(app.deviceId, "dev_mac", "the device was not reset", line: line)
        XCTAssertEqual(app.sessionStore.drafts["s1"], "half a thought", "local data kept", line: line)
        XCTAssertEqual(relay.sentKeys.last ?? nil, storedKey, "the token registers the stored keys again", line: line)
        XCTAssertFalse(KeychainManager().usingEphemeralKeys, line: line)
        XCTAssertNotNil(app.authManager?.credentialSignInAt, line: line)
    }

    /// (c) Another key is registered for the device (e.g. last launch's
    /// process-local one): `invalid_signature`.
    func testKeyMismatchFallsBackToTheTokenQuietly() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = try CryptoManager().exportPublicKeySPKI(
            KeychainManager.makeProcessLocalKeyPair().publicKey)
        try await assertQuietFallbackToTheToken(storedKey: storedKey)
    }

    /// (c) The relay does not know the device (removed, or another relay).
    func testUnknownStoredDeviceFallsBackToTheTokenQuietly() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        try await assertQuietFallbackToTheToken(storedKey: storedKey)
    }

    /// (c) The challenge cannot be signed (Keychain denied after launch):
    /// the token signs in with process-local keys, no error shown.
    func testUnsignableChallengeFallsBackToTheTokenWithProcessLocalKeys() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        app.authManager?.debugChallengeSigningError = KeychainError.loadFailed(errSecInteractionNotAllowed)
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        var sawError = false
        try await waitUntil(10, "signed in") {
            sawError = sawError || app.lastError != nil
            return app.connectionStatus == .connected
        }
        XCTAssertEqual(relay.methods, ["challenge", "github_token"])
        XCTAssertFalse(sawError, "no error flash")
        XCTAssertEqual(app.deviceId, "dev_mac")
        XCTAssertTrue(KeychainManager().usingEphemeralKeys, "auth and decryption both on process-local keys")
        XCTAssertNotEqual(relay.sentKeys.last ?? nil, storedKey)
        XCTAssertNil(app.authManager?.credentialSignInAt)
    }

    /// (d) First launch with this version (nothing recorded, no stored keys
    /// yet): the token signs in registering newly stored keys, so the second
    /// launch signs in with the challenge.
    func testTokenSignInRegistersStoredKeysSoTheNextLaunchUsesTheChallenge() async throws {
        try useTestStoredKeys(create: false)
        relay.challengeMode = .verify
        app = try makeReturningMac(registeredAt: nil)
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertFalse(KeychainManager().usingEphemeralKeys)
        XCTAssertEqual(relay.sentKeys, [try storedSigningKey()])
        let registeredAt = try XCTUnwrap(app.authManager?.credentialSignInAt)

        app.disconnect()
        KeychainManager.debugResetProcessKeys()   // next launch
        app = try makeReturningMac(registeredAt: registeredAt)
        let again = await app.attemptCLILogin()
        XCTAssertTrue(again)
        try await waitUntil(10, "signed in again") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token", "challenge"])
        XCTAssertEqual(relay.verifiedChallenges, 1)
    }

    /// (e) The local Kraki saved a GitHub sign-in after this device last
    /// registered (`kraki connect`, maybe another account): the token signs in.
    func testNewerLocalKrakiSignInUsesTheToken() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        let registeredAt = Date().addingTimeInterval(-3600)
        app = try makeReturningMac(registeredAt: registeredAt, cliSignIn: Date().addingTimeInterval(-60))
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertEqual(relay.sentKeys, [storedKey], "still the stored keys")
        XCTAssertGreaterThan(app.authManager?.credentialSignInAt ?? .distantPast, registeredAt)
    }

    /// (f) Sign Out after a stored-device sign-in stays signed out.
    func testSignOutAfterStoredDeviceSignInStaysSignedOut() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        app.authWatchdogInterval = 0.2
        app.authStuckThreshold = 1
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }

        app.logout()
        let reused = await app.attemptCLILogin()
        XCTAssertFalse(reused)
        await app.recoverCLIAuthentication(reason: "test")
        try await Task.sleep(for: .seconds(1.5))   // watchdog ticks every 0.2 s
        XCTAssertEqual(app.connectionStatus, .awaitingLogin)
        XCTAssertEqual(relay.methods, ["challenge"], "nothing signed in behind the person's back")
        XCTAssertFalse(app.hasStoredCredentials)
        XCTAssertNil(app.authManager?.credentialSignInAt)
        XCTAssertFalse(app.authManager?.signsInWithStoredDevice ?? true)
    }

    // MARK: Slow Head on a live link

    /// 11-27: the account service answered after 6.8–9.4 s and every 5 s
    /// replacement (socket deadline, then the watchdog's stuck_unauthenticated)
    /// threw away a sign-in the edge was still processing. While the link
    /// answers pings neither replaces the socket; the sign-in completes on it.
    func testWatchdogLeavesASlowSignInOnALiveLinkAlone() async throws {
        relay.tokenReplyDelay = 8
        AuthManager.debugCLICredentialLoader = { [url = relay.url] _ in (url, "tok-ok") }
        app = try makeApp()
        app.authManager?.debugSetStoredDeviceId(nil)
        // Keys first: RSA-4096 generation can block the main thread for
        // seconds on a busy machine, delaying the auth frame and the first
        // liveness pong past the watchdog's threshold.
        _ = try KeychainManager().getOrCreateSigningKey()
        _ = try KeychainManager().getOrCreateEncryptionKey()
        app.authStuckThreshold = 4
        _ = await app.attemptCLILogin()
        try await waitUntil(15, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertNil(app.lastAuthRecoveryAt, "no stuck_unauthenticated recovery")
        XCTAssertEqual(app.wsClient?.recoveryReasons ?? ["?"], [])
    }
}
