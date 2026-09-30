import Network
import XCTest
@testable import Kraki_Dev

/// Minimal relay: speaks just enough of the auth handshake to replay the
/// 2026-09-30 incident (after a macOS update the stored Keychain challenge
/// failed or stalled, and `gh` answered only after the launch probe gave up).
@MainActor
private final class FakeRelay {
    enum ChallengeMode { case fatal, hang }

    private let listener: NWListener
    private var connections: [NWConnection] = []
    var challengeMode: ChallengeMode = .fatal
    private(set) var methods: [String] = []
    private(set) var port: UInt16 = 0

    init() throws {
        let parameters = NWParameters.tcp
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
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
        connection.receiveMessage { [weak self] data, _, _, error in
            MainActor.assumeIsolated {
                guard let self, error == nil else { return }
                if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.handle(json, on: connection)
                }
                self.receive(connection)
            }
        }
    }

    private func handle(_ message: [String: Any], on connection: NWConnection) {
        switch message["type"] as? String {
        case "auth_info":
            send(["type": "auth_info_response", "methods": ["github_token"], "githubClientId": "test"], on: connection)
        case "auth":
            let method = (message["auth"] as? [String: Any])?["method"] as? String ?? "?"
            methods.append(method)
            switch method {
            case "challenge":
                if challengeMode == .fatal {
                    send(["type": "auth_error", "code": "device_not_found", "message": "Unknown device"], on: connection)
                }
            case "github_token":
                let token = (message["auth"] as? [String: Any])?["token"] as? String
                if token == "tok-ok" {
                    send(["type": "auth_ok", "deviceId": "dev_recovered",
                          "user": ["id": "1", "login": "tester"], "devices": []], on: connection)
                } else {
                    send(["type": "auth_error", "code": "auth_rejected", "message": "bad token"], on: connection)
                }
            default:
                send(["type": "auth_error", "code": "auth_rejected", "message": "unsupported"], on: connection)
            }
        default:
            break
        }
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
        app?.disconnect()
        app = nil
        relay?.stop()
        relay = nil
    }

    /// App graph as a returning Mac user: a stored (Keychain) device and the
    /// relay under test. Identity stays in memory; nothing persists.
    private func makeApp() throws -> AppState {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-auth-recovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.relayURL = relay.url
        app.hasCompletedInitialConnect = false   // a fresh launch
        app.setupNetworking(outboxURL: root.appendingPathComponent("outbox.json"))
        app.authManager?.useEphemeralKeysForCurrentProcess()
        app.authManager?.debugIsolatedIdentity = true
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
}
