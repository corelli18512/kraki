import Network
import XCTest
@testable import Kraki_Dev

/// After a relay outage the client must reconnect on its own cadence (at most
/// a few seconds apart), not sit in a connection that waits for connectivity
/// until the 10-30 s connect deadline (K-117). Uses a local port only.
@MainActor
final class RelayOutageReconnectTests: XCTestCase {
    /// Inside this lane's port block; nothing listens there until the test starts the relay.
    private let port: UInt16 = 6213

    private func wait(_ seconds: TimeInterval) async throws {
        try await Task.sleep(for: .milliseconds(Int(seconds * 1_000)))
    }

    func testRelayBackAfterAnOutageIsPickedUpWithinSeconds() async throws {
        let client = WebSocketClient(relayURL: "ws://127.0.0.1:\(port)")
        defer { client.disconnect() }
        client.connect()

        // Relay down: a refused connection fails at once and is retried.
        try await wait(2.5)
        XCTAssertTrue(client.recoveryReasons.contains("transport_error"),
                      "a refused connection must fail fast, got \(client.recoveryReasons)")
        XCTAssertFalse(client.recoveryReasons.contains("connect_timeout"),
                       "nothing may wait out the connect deadline while the relay refuses")

        // Let the outage run a little longer, then bring the relay back.
        try await wait(3)
        let parameters = NWParameters.tcp
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        var connections: [NWConnection] = []
        listener.newConnectionHandler = { connection in
            connections.append(connection)
            connection.start(queue: .main)
        }
        listener.start(queue: .main)
        defer {
            connections.forEach { $0.cancel() }
            listener.cancel()
        }
        let relayBack = Date()
        while client.state != .connected, Date().timeIntervalSince(relayBack) < 15 {
            try await wait(0.05)
        }
        let late = Date().timeIntervalSince(relayBack)
        XCTAssertEqual(client.state, .connected)
        XCTAssertLessThan(late, 6, "reconnected \(late) s after the relay came back")
    }
}
