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
    /// pong). `.silent`: no reply, but the link keeps answering pings (a Head
    /// that never answers). `.verify`: a real challenge, verified against the
    /// key the device last registered (`registeredKeys`), `invalid_signature`
    /// otherwise.
    enum ChallengeMode { case fatal, hang, silent, verify }

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
    /// `.verify` challenges are sent this late (the link keeps answering pings).
    var challengeReplyDelay: TimeInterval = 0
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
        case .silent:
            break
        case .verify:
            let deviceId = (message["auth"] as? [String: Any])?["deviceId"] as? String ?? ""
            guard registeredKeys[deviceId] != nil else {
                send(["type": "auth_error", "code": "unknown_device", "message": "Unknown device"], on: connection)
                return
            }
            let nonce = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
            nonces[ObjectIdentifier(connection)] = (deviceId, nonce)
            DispatchQueue.main.asyncAfter(deadline: .now() + challengeReplyDelay) { [weak self] in
                self?.send(["type": "auth_challenge", "nonce": nonce], on: connection)
            }
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
        KeychainManager.debugIdentityItemsUnreadable = false
        KeychainManager.debugIdentityItemWriteFails = false
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

    /// The local Kraki's sign-in (`cliSignInDate()`, the token file's time).
    private let cliSignIn = Date(timeIntervalSince1970: 1_795_000_000)

    /// This process's stored identity, in a test directory (Debug keeps the
    /// items in files, DevSecretFileStore). `create`: it exists already (a
    /// returning Mac). Returns the signing key's SPKI, or nil when not created.
    @discardableResult
    private func useTestStoredKeys(create: Bool = true) throws -> String? {
        DevSecretFileStore.testDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-stored-keys-\(UUID().uuidString)", isDirectory: true)
        KeychainManager.debugResetProcessKeys()
        guard create else { return nil }
        let spki = try storedSigningKey()
        KeychainManager.debugResetProcessKeys()   // the launch reads them itself
        return spki
    }

    private func storedSigningKey() throws -> String {
        XCTAssertTrue(KeychainManager().useStoredIdentityForTokenSignIn())
        return try CryptoManager().exportPublicKeySPKI(KeychainManager().getOrCreateSigningKey().publicKey)
    }

    private func identityItem(_ key: String) -> Data? {
        let tag = key == "signing" ? "chat.kraki.mac.dev.signing-key" : "chat.kraki.mac.dev.encryption-key"
        return DevSecretFileStore.read(KeychainManager.identityFileName(tag))
    }

    /// A returning Mac: device `dev_mac`, whose stored identity was registered
    /// by the token of the local Kraki's sign-in `registered`; the local
    /// Kraki is now on `cliSignIn` (default: the same sign-in).
    private func makeReturningMac(registered: Date?? = .none, cliSignIn: Date? = nil) throws -> AppState {
        let current = cliSignIn ?? self.cliSignIn
        AuthManager.debugCLICredentialLoader = { [url = relay.url] _ in (url, "tok-ok") }
        AuthManager.debugCLISignInDate = { current }
        let app = try makeGraph()
        app.authManager?.debugSetStoredDeviceId("dev_mac")
        app.authManager?.debugSetRegisteredCLISignIn(registered ?? current)
        app.authWatchdogInterval = 60
        return app
    }

    /// (a) A returning Mac whose stored identity reads without Keychain UI
    /// signs in with its challenge, which an edge Head verifies itself,
    /// instead of a token sign-in with new process-local keys that only the
    /// account service on the US main Head could answer (edge log p50 6.8 s
    /// from Beijing; 19 s to a fresh session list on 11-27).
    func testReturningMacSignsInWithItsStoredDeviceNotTheToken() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["challenge"])
        XCTAssertEqual(relay.verifiedChallenges, 1)
        XCTAssertEqual(relay.sentKeys, [storedKey])
        XCTAssertTrue(KeychainManager().usingStoredIdentity, "no process-local keys")
        XCTAssertEqual(app.deviceId, "dev_mac")
        XCTAssertEqual(app.authManager?.cliGitHubToken, "tok-ok", "the token stays loaded for recovery")
        XCTAssertEqual(app.authManager?.registeredCLISignIn, cliSignIn, "a challenge does not move the mark")
    }

    /// (b) Identity items that would need Keychain UI or were denied: the
    /// token signs in with process-local keys as before, the items are left
    /// exactly as they were, and the next launch uses the token again.
    func testUnreadableIdentitySignsInWithTheTokenAndProcessLocalKeys() async throws {
        let storedKey = try useTestStoredKeys()
        let items = (identityItem("signing"), identityItem("encryption"))
        KeychainManager.debugIdentityItemsUnreadable = true
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertTrue(KeychainManager().usingEphemeralKeys)
        XCTAssertNotEqual(relay.sentKeys.first ?? nil, storedKey)
        XCTAssertNil(app.authManager?.registeredCLISignIn, "process-local keys die with the process")
        XCTAssertEqual(identityItem("signing"), items.0, "never overwritten")
        XCTAssertEqual(identityItem("encryption"), items.1, "never overwritten")
    }

    /// The identity cannot be stored: this process signs in with the token
    /// and process-local keys (today's behaviour), the next launch too.
    func testIdentityThatCannotBeStoredSignsInWithProcessLocalKeys() async throws {
        try useTestStoredKeys(create: false)
        KeychainManager.debugIdentityItemWriteFails = true
        relay.challengeMode = .verify
        app = try makeReturningMac(registered: .some(nil))
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertTrue(KeychainManager().usingEphemeralKeys)
        XCTAssertNil(app.authManager?.registeredCLISignIn)
        XCTAssertNil(identityItem("signing"))
        XCTAssertNil(identityItem("encryption"))
    }

    /// The stored identity is key bytes (DER) in one item per pair, imported
    /// into memory: no SecKey item is created or used for it, a relaunch
    /// reads the same keys, and deleting the keys removes the items.
    func testStoredIdentityIsKeyBytesImportedIntoMemory() throws {
        try useTestStoredKeys(create: false)
        let keychain = KeychainManager()
        XCTAssertFalse(keychain.useStoredIdentityIfPresent(), "nothing stored yet, nothing created")
        XCTAssertNil(identityItem("signing"))
        XCTAssertTrue(keychain.useStoredIdentityForTokenSignIn())
        let signing = try keychain.getOrCreateSigningKey()
        let encryption = try keychain.getOrCreateEncryptionKey()
        let crypto = CryptoManager()
        XCTAssertEqual(identityItem("signing"), SecKeyCopyExternalRepresentation(signing.privateKey, nil) as Data?)
        XCTAssertEqual(identityItem("encryption"), SecKeyCopyExternalRepresentation(encryption.privateKey, nil) as Data?)
        XCTAssertNil(DevSecretFileStore.read("chat.kraki.mac.dev.signing-key"), "no SecKey item (legacy store)")
        XCTAssertNil(DevSecretFileStore.read("chat.kraki.mac.dev.encryption-key"), "no SecKey item (legacy store)")

        KeychainManager.debugResetProcessKeys()   // relaunch
        XCTAssertTrue(KeychainManager().useStoredIdentityIfPresent())
        XCTAssertTrue(KeychainManager().usingStoredIdentity)
        let reloaded = try KeychainManager().getOrCreateEncryptionKey()
        XCTAssertEqual(try crypto.exportPublicKeySPKI(reloaded.publicKey), try crypto.exportPublicKeySPKI(encryption.publicKey))
        XCTAssertEqual(try crypto.exportPublicKeySPKI(KeychainManager().getOrCreateSigningKey().publicKey),
                       try crypto.exportPublicKeySPKI(signing.publicKey))
        let blob = try crypto.encryptToBlob("hi", recipients: [.init(deviceId: "d", publicKey: encryption.publicKey)])
        XCTAssertEqual(try crypto.decryptFromBlob(blob, deviceId: "d", privateKey: reloaded.privateKey), "hi")

        try KeychainManager().deleteAllKeys()   // Sign Out / Delete Account
        XCTAssertNil(identityItem("signing"))
        XCTAssertNil(identityItem("encryption"))
        XCTAssertFalse(KeychainManager().usingStoredIdentity)
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
        XCTAssertTrue(KeychainManager().usingStoredIdentity, line: line)
        XCTAssertEqual(app.authManager?.registeredCLISignIn, cliSignIn, line: line)
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

    /// (c) The challenge cannot be signed: the token signs in with
    /// process-local keys, no error shown.
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
        XCTAssertNil(app.authManager?.registeredCLISignIn)
    }

    /// (c) The Head never answers the challenge although the link answers
    /// pings: at the socket's cap the token signs in instead (previously the
    /// watchdog dropped the stored device on any tick).
    func testChallengeUnansweredOnALiveLinkFallsBackToTheTokenAtTheCap() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .silent
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        let started = Date()
        _ = await app.attemptCLILogin()
        try await waitUntil(WebSocketClient.authReplyLiveLinkCap + 10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["challenge", "github_token"])
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), WebSocketClient.authReplyLiveLinkCap - 0.5)
        XCTAssertEqual(relay.sentKeys.last ?? nil, storedKey, "still the stored identity")
        XCTAssertFalse(app.authManager?.signsInWithStoredDevice ?? true)
    }

    /// (d) First launch with this version (nothing recorded, no stored
    /// identity yet): the token signs in registering a newly stored identity,
    /// so the second launch signs in with the challenge.
    func testTokenSignInRegistersStoredKeysSoTheNextLaunchUsesTheChallenge() async throws {
        try useTestStoredKeys(create: false)
        relay.challengeMode = .verify
        app = try makeReturningMac(registered: .some(nil))
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertTrue(KeychainManager().usingStoredIdentity)
        XCTAssertEqual(relay.sentKeys, [try storedSigningKey()])
        XCTAssertEqual(app.authManager?.registeredCLISignIn, cliSignIn)

        app.disconnect()
        KeychainManager.debugResetProcessKeys()   // next launch
        app = try makeReturningMac(registered: app.authManager?.registeredCLISignIn)
        let again = await app.attemptCLILogin()
        XCTAssertTrue(again)
        try await waitUntil(10, "signed in again") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token", "challenge"])
        XCTAssertEqual(relay.verifiedChallenges, 1)
    }

    /// (e) The local Kraki saved another GitHub sign-in since this device
    /// registered (`kraki connect`, maybe another account): the token signs in.
    func testNewerLocalKrakiSignInUsesTheToken() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.registeredKeys["dev_mac"] = storedKey
        let switched = cliSignIn.addingTimeInterval(3600)
        app = try makeReturningMac(registered: cliSignIn, cliSignIn: switched)
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertEqual(relay.sentKeys, [storedKey], "still the stored keys")
        XCTAssertEqual(app.authManager?.registeredCLISignIn, switched)
    }

    /// (e) Review P1-1: signed in, then `kraki connect` with another account
    /// saves a new token while the app runs. A reconnect still uses the old
    /// cached token; it must not record the new sign-in, or every later
    /// launch would sign in to the old account with the challenge.
    func testReconnectWithTheOldCachedTokenAfterAnAccountSwitchKeepsTheNextLaunchOnTheToken() async throws {
        try useTestStoredKeys(create: false)
        relay.challengeMode = .verify
        app = try makeReturningMac(registered: .some(nil))
        _ = await app.attemptCLILogin()
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(app.authManager?.registeredCLISignIn, cliSignIn)

        let switched = cliSignIn.addingTimeInterval(3600)
        AuthManager.debugCLISignInDate = { switched }   // `kraki connect` as account B
        app.reconnectForNewCredentials(reason: "test")
        try await waitUntil(10, "signed in again") {
            relay.methods.count == 2 && app.connectionStatus == .connected
        }

        app.disconnect()
        KeychainManager.debugResetProcessKeys()   // next launch
        app = try makeReturningMac(registered: app.authManager?.registeredCLISignIn, cliSignIn: switched)
        _ = await app.attemptCLILogin()
        try await waitUntil(10, "signed in after relaunch") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token", "github_token", "github_token"],
                       "the next launch after the account switch must use the (new) token")
        XCTAssertEqual(app.authManager?.registeredCLISignIn, switched)
    }

    /// (f) Sign Out after a stored-device sign-in stays signed out.
    /// Review 2, note 1: `kraki connect` saves another account's sign-in
    /// between loading the (old) token and reading the sign-in date. The old
    /// token must not be tied to the new sign-in, or later launches would keep
    /// the old account's challenge; the next launch uses the token instead.
    func testAccountSwitchWhileTheTokenLoadsIsNotTiedToTheNewSignIn() async throws {
        try useTestStoredKeys(create: false)
        relay.challengeMode = .verify
        app = try makeReturningMac(registered: .some(nil))
        let switched = cliSignIn.addingTimeInterval(3600)
        AuthManager.debugCLICredentialLoader = { [url = relay.url] _ in
            AuthManager.debugCLISignInDate = { switched }   // written right after the old token was read
            return (url, "tok-ok")
        }
        let signedIn = await app.attemptCLILogin()
        XCTAssertTrue(signedIn)
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["github_token"])
        XCTAssertNil(app.authManager?.registeredCLISignIn, "the old token is not tied to the new sign-in")
    }

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
        XCTAssertNil(app.authManager?.registeredCLISignIn)
        XCTAssertFalse(app.authManager?.signsInWithStoredDevice ?? true)
    }

    /// Review P2: after an outage longer than the watchdog's threshold
    /// (`notConnectedSince` already old), a tick landing while the stored
    /// device's challenge is in flight, before any probe pong, gave up on
    /// the stored device for the process and replaced the socket. It now
    /// waits for the reply.
    func testWatchdogTickDuringAnInFlightChallengeKeepsTheStoredDevice() async throws {
        let storedKey = try useTestStoredKeys()
        relay.challengeMode = .verify
        relay.challengeReplyDelay = 2.5
        relay.registeredKeys["dev_mac"] = storedKey
        app = try makeReturningMac()
        app.authWatchdogInterval = 0.2
        app.authStuckThreshold = 1
        app.notConnectedSince = Date().addingTimeInterval(-30)
        _ = await app.attemptCLILogin()
        try await waitUntil(10, "signed in") { app.connectionStatus == .connected }
        XCTAssertEqual(relay.methods, ["challenge"])
        XCTAssertEqual(relay.verifiedChallenges, 1)
        XCTAssertNil(app.lastAuthRecoveryAt, "no stuck_unauthenticated recovery")
        XCTAssertTrue(app.authManager?.signsInWithStoredDevice ?? false, "the stored device is kept")
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
