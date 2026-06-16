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

    private(set) var relayURL: String

    private static let reconnectBase: TimeInterval = 1.0
    private static let reconnectMax: TimeInterval = 30.0
    // Note: there is intentionally no hard retry cap. We keep backing
    // off (exponential, capped at `reconnectMax`) for as long as the
    // app is foregrounded — matching what Slack / WhatsApp / iMessage
    // do. Users get an ambient indicator while we keep trying rather
    // than a blocking "we gave up" dialog.
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

    /// Called on the main queue every time the retry counter bumps
    /// (or resets to 0 after a successful connect).
    var onReconnectAttempt: ((Int) -> Void)?

    // MARK: Internals

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private var reconnectWorkItem: DispatchWorkItem?
    private var reconnectDelay: TimeInterval
    private var reconnectAttempts = 0
    private var intentionalClose = false

    // MARK: Outbound retry queue
    //
    // Commands sent while the socket is mid-(re)connect or
    // mid-authenticate would previously vanish silently. We now
    // buffer them in a small queue (capped + TTL'd) and flush on
    // reconnect+auth-ready. Only message kinds explicitly marked
    // `queueOnFailure: true` are queued — auth/handshake frames are
    // not, since they're inherently tied to a specific socket session.
    private struct QueuedFrame {
        let payload: String
        let queuedAt: Date
    }
    private var outboundQueue: [QueuedFrame] = []
    private static let outboundQueueCap = 200
    private static let outboundQueueTTL: TimeInterval = 60

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
        // Raise the WS frame size limit. iOS default is 1 MB which
        // is too small for our session_messages_batch payloads —
        // a single batch containing one long agent reply can easily
        // exceed 1.5 MB, causing receive to fail with "Message too
        // long" and the connection to drop. 16 MB gives plenty of
        // headroom while staying well below what URLSession enforces
        // as an absolute upper bound.
        task?.maximumMessageSize = 16 * 1024 * 1024
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
        // Clear the outbound queue too — any frames buffered here
        // were addressed to the now-defunct session/identity and
        // shouldn't survive an intentional disconnect (e.g. logout
        // would otherwise replay old user commands at next login).
        outboundQueue.removeAll()
        state = .disconnected
    }

    func setRelayURL(_ newURL: String) {
        guard newURL != relayURL else {
            return
        }
        relayURL = newURL
        intentionalClose = true
        cleanup()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        reconnectAttempts = 0
        reconnectDelay = Self.reconnectBase
        // Discard any queued frames bound for the old relay — see
        // `AppState.redirectToRelay` for the matching encryption
        // queue clear. Both queues hold ciphertext + envelopes tied
        // to the OLD device identity, useless at the new relay.
        outboundQueue.removeAll()
        // Reconnect to the new URL on the next runloop tick so callers
        // can finish updating any state before we touch the network.
        DispatchQueue.main.async { [weak self] in
            self?.connect()
        }
    }

    /// Send an `Encodable` message. Treated as a user command, so if
    /// the socket is mid-(re)connect we queue the payload for retry
    /// when the connection is back. Drops happen only on encode
    /// failure or once the queue cap / TTL is exceeded.
    func send<T: Encodable>(_ message: T) {
        do {
            let data = try JSONEncoder().encode(message)
            guard let string = String(data: data, encoding: .utf8) else {
                KLog.d("⚠️ ws send dropped — non-utf8 payload")
                return
            }
            if state == .connected, isAuthenticated {
                // Encodable user commands are retryable.
                writeString(string, retryOnSendError: true)
            } else {
                enqueueOutbound(string)
                KLog.d("⏳ ws send queued — state=\(state) authed=\(isAuthenticated)")
            }
        } catch {
            KLog.d("⚠️ ws send dropped — encode failed: \(error)")
        }
    }

    /// Send a raw JSON string. `queueOnFailure` opts the frame into
    /// the retry queue when the socket isn't ready — used for
    /// encrypted user commands routed via `AppState`. Auth handshake
    /// frames pass `queueOnFailure: false` because they're tied to
    /// the current socket session and can't survive a reconnect. The
    /// same flag also gates retry on `URLSessionWebSocketTask.send`
    /// completion errors — auth/handshake/ping frames don't get
    /// requeued because replaying them on a new socket session is
    /// either nonsensical (ping) or actively wrong (auth challenge
    /// signed against a stale nonce).
    func sendRaw(_ string: String, queueOnFailure: Bool = false) {
        guard state == .connected else {
            if queueOnFailure {
                enqueueOutbound(string)
                KLog.d("⏳ sendRaw queued — not connected")
            } else {
                KLog.d("⚠️ sendRaw blocked — not connected")
            }
            return
        }
        KLog.d("📤 \(String(string.prefix(120)))")
        writeString(string, retryOnSendError: queueOnFailure)
    }

    func setAuthenticated(_ value: Bool) {
        isAuthenticated = value
        if value {
            flushOutboundQueue()
        }
    }

    // MARK: - Outbound Queue helpers

    private func enqueueOutbound(_ payload: String) {
        // Drop expired entries before considering the cap so the
        // queue doesn't get poisoned by ancient stale commands.
        let now = Date()
        outboundQueue.removeAll { now.timeIntervalSince($0.queuedAt) > Self.outboundQueueTTL }
        if outboundQueue.count >= Self.outboundQueueCap {
            // Cap reached — drop the oldest to keep the freshest commands.
            outboundQueue.removeFirst()
            KLog.d("⚠️ outbound queue full — dropped oldest")
        }
        outboundQueue.append(QueuedFrame(payload: payload, queuedAt: now))
    }

    private func flushOutboundQueue() {
        guard !outboundQueue.isEmpty else { return }
        let now = Date()
        let queue = outboundQueue
        outboundQueue.removeAll()
        KLog.d("🔄 flushing \(queue.count) queued ws frames")
        for frame in queue {
            if now.timeIntervalSince(frame.queuedAt) > Self.outboundQueueTTL {
                KLog.d("⚠️ ws frame TTL expired — dropping")
                continue
            }
            // Frames in this queue are by definition retryable (only
            // retryable callers — `send<T>` and
            // `sendRaw(queueOnFailure: true)` — enqueue), so a wire
            // failure during flush should fall back into the queue
            // again rather than vanish.
            writeString(frame.payload, retryOnSendError: true)
        }
    }

    // MARK: - WebSocket I/O

    /// Send a frame on the wire. `retryOnSendError` decides what
    /// happens if the URLSession completion fires with an error
    /// (transient network blip, socket closed mid-write,
    /// backpressure):
    ///   - `true`  → re-queue for the reconnect-and-flush path.
    ///   - `false` → drop with a log line; for non-retryable frames
    ///                like auth handshake, ping, and other
    ///                session-bound control plane messages where
    ///                replay would be wrong (challenge nonce signed
    ///                against the previous socket) or pointless
    ///                (next ping fires on its own timer).
    private func writeString(_ string: String, retryOnSendError: Bool) {
        let message = URLSessionWebSocketTask.Message.string(string)
        task?.send(message) { [weak self] error in
            guard let error else { return }
            KLog.d("⚠️ ws send completion failed: \(error)")
            guard retryOnSendError else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.enqueueOutbound(string)
            }
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
            // Pings are not retryable — the next ping fires on its
            // own timer 25s later, and replaying a stale heartbeat
            // adds no value.
            self.writeString("{\"type\":\"ping\"}", retryOnSendError: false)
        }
    }

    private func stopPing() {
        pingTimer?.invalidate()
        pingTimer = nil
    }

    // MARK: - Reconnect

    private func scheduleReconnect() {
        guard reconnectWorkItem == nil else { return }

        let delay = reconnectDelay
        reconnectAttempts += 1
        reconnectDelay = min(reconnectDelay * 2, Self.reconnectMax)
        onReconnectAttempt?(reconnectAttempts)

        let work = DispatchWorkItem { [weak self] in
            self?.reconnectWorkItem = nil
            self?.connect()
        }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Reset backoff to base and connect immediately. Use on app-
    /// foreground transitions so the user doesn't have to wait out a
    /// long backoff timer that started in the background.
    func resetBackoffAndReconnect() {
        cancelReconnect()
        reconnectDelay = Self.reconnectBase
        reconnectAttempts = 0
        onReconnectAttempt?(0)
        connect()
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
        onReconnectAttempt?(0)
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
        let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) } ?? "nil"
        KLog.d("🔒 WebSocket closed code=\(closeCode.rawValue) reason=\(reasonStr) intentional=\(intentionalClose) url=\(relayURL)")
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
        guard let error else { return }
        KLog.d("⚠️ WebSocket didCompleteWithError \(error.localizedDescription) intentional=\(intentionalClose) url=\(relayURL)")
        cleanup()
        if !intentionalClose {
            state = .disconnected
            scheduleReconnect()
        }
    }
}
