/// WebSocketClient — URLSessionWebSocketTask-based transport layer.
///
/// Mirrors the behaviour of `transport.ts`:
/// - Connects to the relay URL over WebSocket
/// - Auto-reconnects with exponential back-off (1 s base, 30 s cap, 5 attempts)
/// - Sends a JSON `{"type":"ping"}` every 25 seconds
/// - Exposes an `isAuthenticated` gate: `send(_:)` is blocked until auth
///   succeeds, while `sendRaw(_:)` bypasses the gate for the auth handshake.

import Foundation

// MARK: - WebSocketState

enum WebSocketState {
    case disconnected
    case connecting
    case connected
}

// MARK: - WebSocketClient

final class WebSocketClient: NSObject {

    // MARK: Configuration

    private let relayURL: String

    private static let reconnectBase: TimeInterval = 1.0
    private static let reconnectMax: TimeInterval = 30.0
    private static let maxReconnectAttempts = 5
    private static let pingInterval: TimeInterval = 25.0

    // MARK: Observable state

    private(set) var state: WebSocketState = .disconnected {
        didSet {
            guard state != oldValue else { return }
            onStateChange?(state)
        }
    }

    private(set) var isAuthenticated = false

    // MARK: Callbacks

    /// Called on the main queue when a complete text frame arrives.
    var onMessage: ((Data) -> Void)?

    /// Called on the main queue when the connection state changes.
    var onStateChange: ((WebSocketState) -> Void)?

    // MARK: Internals

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private var reconnectWorkItem: DispatchWorkItem?
    private var reconnectDelay: TimeInterval
    private var reconnectAttempts = 0
    private var intentionalClose = false

    // MARK: - Init

    init(relayURL: String) {
        self.relayURL = relayURL
        self.reconnectDelay = Self.reconnectBase
        super.init()
    }

    // MARK: - Public API

    func connect() {
        cancelReconnect()
        intentionalClose = false

        guard let url = URL(string: relayURL) else {
            KLog.d("❌ Invalid relay URL: \(relayURL)")
            state = .disconnected
            return
        }

        KLog.d("🔌 Connecting to \(relayURL)...")
        state = .connecting

        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        session = URLSession(
            configuration: configuration,
            delegate: self,
            delegateQueue: .main
        )
        task = session?.webSocketTask(with: url)
        task?.resume()
    }

    func disconnect() {
        intentionalClose = true
        cleanup()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        reconnectAttempts = 0
        state = .disconnected
    }

    /// Send an `Encodable` message — gated by `isAuthenticated`.
    func send<T: Encodable>(_ message: T) {
        guard state == .connected, isAuthenticated else { return }
        do {
            let data = try JSONEncoder().encode(message)
            guard let string = String(data: data, encoding: .utf8) else { return }
            writeString(string)
        } catch {
            // Encoding failure — message is silently dropped.
        }
    }

    /// Send a raw JSON string without the auth gate (used for the auth handshake).
    func sendRaw(_ string: String) {
        guard state == .connected else {
            KLog.d("⚠️ sendRaw blocked — not connected")
            return
        }
        KLog.d("📤 \(String(string.prefix(120)))")
        writeString(string)
    }

    func setAuthenticated(_ value: Bool) {
        isAuthenticated = value
    }

    // MARK: - WebSocket I/O

    private func writeString(_ string: String) {
        let message = URLSessionWebSocketTask.Message.string(string)
        task?.send(message) { _ in
            // Send-completion errors are handled by the delegate when the
            // connection closes.
        }
    }

    private func listenForMessages() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        self.onMessage?(data)
                    }
                case .data(let data):
                    self.onMessage?(data)
                @unknown default:
                    break
                }
                // Continue listening for the next frame.
                self.listenForMessages()
            case .failure:
                // Connection lost — URLSessionDelegate methods handle reconnection.
                break
            }
        }
    }

    // MARK: - Ping

    private func startPing() {
        stopPing()
        pingTimer = Timer.scheduledTimer(
            withTimeInterval: Self.pingInterval,
            repeats: true
        ) { [weak self] _ in
            guard let self,
                  self.state == .connected,
                  self.isAuthenticated else { return }
            self.writeString("{\"type\":\"ping\"}")
        }
    }

    private func stopPing() {
        pingTimer?.invalidate()
        pingTimer = nil
    }

    // MARK: - Reconnect

    private func scheduleReconnect() {
        guard reconnectWorkItem == nil else { return }
        guard reconnectAttempts < Self.maxReconnectAttempts else { return }

        let delay = reconnectDelay
        reconnectAttempts += 1
        reconnectDelay = min(reconnectDelay * 2, Self.reconnectMax)

        let work = DispatchWorkItem { [weak self] in
            self?.reconnectWorkItem = nil
            self?.connect()
        }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelReconnect() {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
    }

    private func cleanup() {
        isAuthenticated = false
        stopPing()
        cancelReconnect()
    }
}

// MARK: - URLSessionWebSocketDelegate

extension WebSocketClient: URLSessionWebSocketDelegate {

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        KLog.d("✅ WebSocket opened")
        reconnectDelay = Self.reconnectBase
        reconnectAttempts = 0
        state = .connected
        startPing()
        listenForMessages()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        cleanup()
        if !intentionalClose {
            state = .disconnected
            scheduleReconnect()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard error != nil else { return }
        cleanup()
        if !intentionalClose {
            state = .disconnected
            scheduleReconnect()
        }
    }
}
