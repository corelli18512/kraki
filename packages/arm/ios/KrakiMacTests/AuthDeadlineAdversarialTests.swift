import Network
import XCTest
@testable import Kraki_Dev

@MainActor
private final class DelayedAuthRelay {
    let listener: NWListener
    var delay: TimeInterval?
    var sendUnrelatedFrame = false
    var connections: [NWConnection] = []
    var pending: [DispatchWorkItem] = []
    var auths = 0
    var infoRequests = 0
    init() throws {
        let parameters = NWParameters.tcp
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        listener = try NWListener(using: parameters, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated {
                self?.connections.append(connection)
                connection.start(queue: .main)
                self?.receive(connection)
            }
        }
    }
    func start() async throws -> String {
        listener.start(queue: .main)
        let deadline = Date().addingTimeInterval(5)
        while listener.state != .ready || listener.port == nil {
            if Date() > deadline { throw XCTSkip("local listener not ready") }
            try await Task.sleep(for: .milliseconds(20))
        }
        return "ws://127.0.0.1:\(listener.port?.rawValue ?? 0)"
    }
    func stop() { pending.forEach { $0.cancel() }; connections.forEach { $0.cancel() }; listener.cancel() }
    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, _, _, error in
            MainActor.assumeIsolated {
                guard let self, error == nil else { return }
                if let data, let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if message["type"] as? String == "auth_info" {
                        self.infoRequests += 1
                        self.send(["type": "auth_info_response", "methods": ["pairing"]], on: connection)
                    } else if message["type"] as? String == "auth" {
                        self.auths += 1
                        if self.sendUnrelatedFrame {
                            self.after(1) { [weak self] in self?.send(["type": "pong"], on: connection) }
                        }
                        if let delay = self.delay {
                            self.after(delay) { [weak self] in self?.send(["type": "auth_ok"], on: connection) }
                        }
                    }
                }
                self.receive(connection)
            }
        }
    }
    private func after(_ delay: TimeInterval, _ action: @escaping () -> Void) {
        let work = DispatchWorkItem(block: action)
        pending.append(work)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
    private func send(_ object: [String: Any], on connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "qa-text", metadata: [metadata])
        connection.send(content: try? JSONSerialization.data(withJSONObject: object), contentContext: context, isComplete: true, completion: .idempotent)
    }
}

@MainActor
final class AuthDeadlineAdversarialTests: XCTestCase {
    private func waitUntil(_ seconds: TimeInterval, _ predicate: () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !predicate(), Date() < end { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(predicate(), "condition not met within \(seconds)s")
    }
    private func runSlow(_ delay: TimeInterval, within seconds: TimeInterval, expectedAttempts: Int) async throws {
        let relay = try DelayedAuthRelay(); relay.delay = delay
        let client = WebSocketClient(relayURL: try await relay.start())
        defer { client.disconnect(); relay.stop() }
        client.onStateChange = { [weak client] state in
            if state == .connected { client?.sendRaw("{\"type\":\"auth\",\"auth\":{\"method\":\"github_token\",\"token\":\"qa\"}}") }
        }
        client.onMessage = { [weak client] data in
            if let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any], message["type"] as? String == "auth_ok" { client?.setAuthenticated(true) }
        }
        client.connect()
        try await waitUntil(seconds) { client.isAuthenticated }
        XCTAssertEqual(relay.auths, expectedAttempts)
        XCTAssertEqual(client.consecutiveAuthReplyTimeouts, 0)
    }
    func testReplyAt4Point9SecondsDoesNotReplaceWorkingSocket() async throws { try await runSlow(4.9, within: 8, expectedAttempts: 1) }
    func testReplyAt6SecondsSucceedsWithDoubledDeadline() async throws { try await runSlow(6, within: 15, expectedAttempts: 2) }
    func testReplyAt15SecondsEventuallySucceedsWith20SecondDeadline() async throws { try await runSlow(15, within: 38, expectedAttempts: 3) }

    func testUnrelatedInboundFrameDoesNotCancelTheAuthReplyDeadline() async throws {
        let relay = try DelayedAuthRelay(); relay.sendUnrelatedFrame = true
        let client = WebSocketClient(relayURL: try await relay.start())
        defer { client.disconnect(); relay.stop() }
        client.onStateChange = { [weak client] state in
            if state == .connected { client?.sendRaw("{\"type\":\"auth\",\"auth\":{\"method\":\"challenge\",\"deviceId\":\"qa\"}}") }
        }
        client.connect()
        try await Task.sleep(for: .seconds(7))
        XCTAssertTrue(client.recoveryReasons.contains("auth_reply_timeout"), "a pong is not an answer to a stuck sign-in")
    }

    func testPairingAndLoginScreenAreNotRetriedAfterFiveSeconds() async throws {
        for frame in ["{\"type\":\"auth\",\"auth\":{\"method\":\"pairing\",\"token\":\"qa\"}}", "{\"type\":\"auth_info\"}"] {
            let relay = try DelayedAuthRelay()
            let client = WebSocketClient(relayURL: try await relay.start())
            client.onStateChange = { [weak client] state in if state == .connected { client?.sendRaw(frame) } }
            client.connect()
            try await Task.sleep(for: .seconds(6))
            XCTAssertFalse(client.recoveryReasons.contains("auth_reply_timeout"))
            XCTAssertEqual(relay.auths + relay.infoRequests, 1)
            client.disconnect(); relay.stop()
        }
    }
}
