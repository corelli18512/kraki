import XCTest
import CryptoKit
import Network
import SwiftUI
@testable import Kraki

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

}

/// A raw TCP server on a port of this lane's block (6090-6099). `respond`
/// answers each received chunk; nil keeps silent. Main queue only.
private final class RawTCPServer {
    private let listener: NWListener
    private var connections: [NWConnection] = []
    private let respond: (NWConnection, Data) -> Data?

    init(port: UInt16, respond: @escaping (NWConnection, Data) -> Data?) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters, on: try XCTUnwrap(NWEndpoint.Port(rawValue: port)))
        self.respond = respond
        let ready = XCTestExpectation(description: "listening on \(port)")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.connections.append(connection)
            connection.start(queue: .main)
            self.receive(on: connection)
        }
        listener.start(queue: .main)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 3), .completed)
    }

    private func receive(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data, !data.isEmpty, let reply = self.respond(connection, data) {
                connection.send(content: reply, completion: .contentProcessed { _ in })
            }
            if !done, error == nil { self.receive(on: connection) }
        }
    }

    func stop() {
        connections.forEach { $0.cancel() }
        listener.cancel()
    }

    /// `101 Switching Protocols` for a WebSocket upgrade request.
    static func upgradeReply(_ request: Data) -> Data? {
        guard let text = String(data: request, encoding: .utf8), text.hasPrefix("GET "),
              let keyLine = text.components(separatedBy: "\r\n")
                .first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") }) else { return nil }
        let key = keyLine.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces)
        let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
        let accept = Data(digest).base64EncodedString()
        return Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)
    }

    /// A pong for a (masked, short) client ping frame; nil for anything else.
    static func pongReply(_ frame: Data) -> Data? {
        let bytes = [UInt8](frame)
        guard bytes.count >= 6, bytes[0] & 0x0F == 0x9 else { return nil }
        let length = Int(bytes[1] & 0x7F)
        guard length < 126, bytes.count >= 6 + length else { return nil }
        let mask = Array(bytes[2..<6])
        let payload = (0..<length).map { bytes[6 + $0] ^ mask[$0 % 4] }
        return Data([0x8A, UInt8(length)] + payload)
    }
}

/// K-086 / K-196 / K-184: transport failures are noticed in seconds, and the
/// one that retrying cannot fix is explained.
@MainActor
final class RelayTransportRecoveryTests: XCTestCase {
    private func settle(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            settle(0.05)
        }
        return condition()
    }

    /// K-086: back on screen over a kept socket that went half-open (the
    /// server no longer answers pings), the link is replaced in seconds
    /// instead of after the 22 s liveness ping.
    func testResumeProbeReplacesAHalfOpenSocketQuickly() throws {
        let server = try RawTCPServer(port: 6091) { _, data in RawTCPServer.upgradeReply(data) }
        defer { server.stop() }
        let socket = WebSocketClient(relayURL: "ws://127.0.0.1:6091")
        defer { socket.disconnect() }
        socket.connect()
        XCTAssertTrue(waitUntil(5) { socket.state == .connected })
        socket.probeAfterResume(timeout: 0.5)
        XCTAssertTrue(waitUntil(3) { socket.recoveryReasons.contains("resume_ping_timeout") },
                      "reasons: \(socket.recoveryReasons)")
    }

    func testResumeProbeKeepsALiveSocket() throws {
        let server = try RawTCPServer(port: 6092) { _, data in
            RawTCPServer.upgradeReply(data) ?? RawTCPServer.pongReply(data)
        }
        defer { server.stop() }
        let socket = WebSocketClient(relayURL: "ws://127.0.0.1:6092")
        defer { socket.disconnect() }
        socket.connect()
        XCTAssertTrue(waitUntil(5) { socket.state == .connected })
        socket.probeAfterResume(timeout: 0.5)
        settle(1.5)
        XCTAssertEqual(socket.recoveryReasons, [])
        XCTAssertEqual(socket.state, .connected)
    }

    /// K-196: a captive portal answers the upgrade with a redirect to its
    /// login page, which never completes a WebSocket handshake. The attempt
    /// must fail at once, not hang until the 10-30 s connect timeout.
    func testCaptivePortalRedirectFailsTheAttemptAtOnce() throws {
        let portal = try RawTCPServer(port: 6094) { _, _ in nil } // accepts, never answers
        defer { portal.stop() }
        let gateway = try RawTCPServer(port: 6093) { _, _ in
            Data("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:6094/portal\r\nContent-Length: 0\r\n\r\n".utf8)
        }
        defer { gateway.stop() }
        let socket = WebSocketClient(relayURL: "ws://127.0.0.1:6093")
        defer { socket.disconnect() }
        socket.connect()
        XCTAssertTrue(waitUntil(4) { !socket.recoveryReasons.isEmpty }, "the attempt hung")
        XCTAssertEqual(socket.recoveryReasons.first, "transport_error")
        XCTAssertEqual(socket.consecutiveConnectTimeouts, 0)
    }

    /// K-184: plain ws:// to a host name is refused by App Transport
    /// Security; the user is told what to change instead of "Connecting…"
    /// forever.
    func testInsecureHostNameRelayIsExplained() throws {
        let socket = WebSocketClient(relayURL: "ws://kraki-ats-probe.example:6095")
        defer { socket.disconnect() }
        var codes: [Int?] = []
        socket.onRecover = { reason, code, _ in if reason == "transport_error" { codes.append(code) } }
        socket.connect()
        XCTAssertTrue(waitUntil(5) { !codes.isEmpty })
        XCTAssertEqual(codes.first ?? nil, NSURLErrorAppTransportSecurityRequiresSecureConnection)
        XCTAssertEqual(AppState.transportFailureNotice(code: codes.first ?? nil),
                       "Kraki can't connect to an unencrypted ws:// address with a host name. Use the relay's wss:// address, or its IP address.")
        XCTAssertNil(AppState.transportFailureNotice(code: NSURLErrorTimedOut))
    }
}

/// K-187 / K-304: errors raised while signed in are shown over the signed-in
/// shell, not only on the sign-in screen.
@MainActor
final class SignedInErrorToastTests: XCTestCase {
    func testSignedInErrorsAreShownAndCleared() throws {
        let app = AppState(testDatabase: MessageDatabase(inMemory: ()))
        let host = UIHostingController(rootView: SignedInErrorToast().environment(app))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 300)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        func shownHeight() -> CGFloat {
            RunLoop.main.run(until: Date().addingTimeInterval(0.6))
            return host.sizeThatFits(in: CGSize(width: 390, height: 1_000)).height
        }
        let empty = shownHeight() // nothing to show: safe-area padding only

        // An auth outage being retried while signed in (K-304), then a
        // refused server command (K-187).
        for message in ["Authentication temporarily unavailable. Reconnecting…", "Cannot remove an online device"] {
            app.lastError = message
            XCTAssertGreaterThan(shownHeight(), empty + 30, message)
            XCTAssertEqual(SignedInErrorToast.visibleMessage(app.lastError), message)
        }
        app.lastError = nil
        XCTAssertEqual(shownHeight(), empty, accuracy: 0.5)
        XCTAssertNil(SignedInErrorToast.visibleMessage(""))
    }
}
