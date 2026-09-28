/// WebSocketClient — URLSessionWebSocketTask-based transport layer.
///
/// Mirrors the behaviour of `transport.ts`:
/// - Connects to the relay URL over WebSocket
/// - Sole physical reconnect owner (1 s base, 30 s cap, no retry cap)
/// - Sends protocol-level pings and actively detects half-open sockets
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

    private static let reconnectBase: TimeInterval = 0.5
    /// Reconnect cadence while the relay is unreachable: at most `fastCap`
    /// apart for the first two minutes of an outage (a returning network is
    /// picked up within a few seconds), then 15 s, then 30 s after ten minutes
    /// so a long outage costs almost nothing. Jitter spreads reconnects when a
    /// relay restart drops many clients at once.
    private static let reconnectFastCap: TimeInterval = 4.0
    private static let reconnectMax: TimeInterval = 30.0
    // Note: there is intentionally no hard retry cap. We keep backing
    // off (exponential, capped at `reconnectMax`) for as long as the
    // app is foregrounded — matching what Slack / WhatsApp / iMessage
    // do. Users get an ambient indicator while we keep trying rather
    // than a blocking "we gave up" dialog.
    private static let pingInterval: TimeInterval = 10.0
    /// The liveness check is intentionally shorter than the relay's roughly
    /// 30-second presence cadence. It catches a sleep/proxy half-open before
    /// the relay has to evict the stale connection.
    private static let livenessCheckInterval: TimeInterval = 2.0
    /// Tolerates latency spikes up to ~20 s (mobile handover, bufferbloat)
    /// while still detecting a half-open link within ~26 s.
    private static let livenessPingTimeout: TimeInterval = 22.0
    /// While real payload keeps arriving, our pong may sit behind the whole
    /// downlink backlog. The bound only matters if the uplink is broken while
    /// the downlink streams; the Relay independently drops a client it hears
    /// nothing from within about a minute, which closes this socket too.
    private static let congestedPingTimeout: TimeInterval = 300.0
    /// Whether real payload (not heartbeats) arrived recently; set by the
    /// owner, which sees decoded Pulse deliveries.
    var isReceivingPayload: () -> Bool = { false }
    private static let livenessTimeout: TimeInterval = 45.0
    private static let stableConnectionInterval: TimeInterval = 15.0

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
    private var livenessTimer: Timer?
    private var lastLivenessAt: Date?
    /// Start of the current outage (first failed/closed connection since the
    /// last stable connection); drives the reconnect cadence.
    private var outageStartedAt: Date?
    #if DEBUG
    /// Why this client replaced its connection (tests only).
    private(set) var recoveryReasons: [String] = []
    /// When each reconnect attempt was scheduled (tests only).
    private(set) var reconnectScheduledAt: [Date] = []
    #endif
    /// Outbound frames handed to URLSession and not yet written, and when the
    /// last one completed. While our own upload is in progress, our ping (and
    /// the Relay's pong to it) waits behind it: completions still arriving
    /// prove the uplink is moving, not dead.
    private var pendingWrites = 0
    private var lastWriteCompletedAt: Date?

    private func isUploading(_ now: Date) -> Bool {
        guard pendingWrites > 0, let last = lastWriteCompletedAt else { return false }
        return now.timeIntervalSince(last) < 25
    }

    /// Most recent inbound activity (a frame, a pong, or bytes in progress).
    var lastInboundActivityAt: Date? { lastLivenessAt }
    private var livenessPingStartedAt: Date?
    private var stableConnectionWorkItem: DispatchWorkItem?
    private var reconnectWorkItem: DispatchWorkItem?
    private var reconnectDelay: TimeInterval
    private var reconnectAttempts = 0
    private var intentionalClose = false
    private var generation = 0
    private var phaseDeadline: DispatchWorkItem?
    static let connectTimeout: TimeInterval = 30
    static let authenticationTimeout: TimeInterval = 90

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

    /// Ensure-connected is idempotent, including the authentication phase.
    func connect() {
        guard state == .disconnected else { return }
        startConnection()
    }

    private func startConnection() {
        generation += 1
        cancelReconnect()
        intentionalClose = false

        guard let url = URL(string: relayURL) else {
            KLog.d("❌ Invalid relay URL: \(relayURL)")
            state = .disconnected
            return
        }

        KLog.d("🔌 Connecting to \(relayURL)...")
        // Only explicit force-rehydrate and our owned retry enter here.
        // Public connect() is ensure-connected, not replacement. URLSession does not
        // cancel the previous webSocketTask when its owning properties are
        // overwritten; without this teardown every retry leaves another live
        // proxy/TCP connection behind and stale auth callbacks can race the
        // newest socket.
        let previousTask = task
        let previousSession = session
        task = nil
        session = nil
        previousTask?.cancel(with: .goingAway, reason: nil)
        previousSession?.invalidateAndCancel()
        let hadTransport = task != nil || previousTask != nil || state != .disconnected || isAuthenticated
        cleanup()
        intentionalClose = false
        // A forced replacement can start while AppState still says
        // `.connected` (the exact sleep/wake half-open case). Publish a real
        // disconnect first so Pulse and session subscriptions retire the old
        // connection epoch before the new auth handshake starts.
        if hadTransport {
            state = .disconnected
        }
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
        armPhaseDeadline(after: Self.connectTimeout, reason: "connect_timeout")
    }

    func disconnect() {
        generation += 1
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
        generation += 1
        let epoch = generation
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
        state = .disconnected
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == epoch else { return }
            self.startConnection()
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
        KLog.d("📤 ws frame type=\(Self.frameType(string)) bytes=\(string.utf8.count)")
        writeString(string, retryOnSendError: queueOnFailure)
    }

    func setAuthenticated(_ value: Bool) {
        isAuthenticated = value
        stableConnectionWorkItem?.cancel()
        stableConnectionWorkItem = nil
        if value {
            phaseDeadline?.cancel(); phaseDeadline = nil
            flushOutboundQueue()
            scheduleStableConnectionReset()
        }
    }

    private func scheduleStableConnectionReset() {
        let epoch = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.generation == epoch,
                  self.state == .connected,
                  self.isAuthenticated else { return }
            self.reconnectDelay = Self.reconnectBase
            self.reconnectAttempts = 0
            self.outageStartedAt = nil
            self.onReconnectAttempt?(0)
            self.stableConnectionWorkItem = nil
            KLog.d("✅ WebSocket stable for \(Int(Self.stableConnectionInterval))s — reconnect backoff reset")
        }
        stableConnectionWorkItem = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.stableConnectionInterval,
            execute: work
        )
    }

    private static func frameType(_ string: String) -> String {
        guard let data = string.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return "unknown" }
        return type
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
        let sendingTask = task
        pendingWrites += 1
        sendingTask?.send(message) { [weak self] error in
            DispatchQueue.main.async {
                guard let self, self.task === sendingTask else { return }
                self.pendingWrites = max(0, self.pendingWrites - 1)
                if error == nil { self.lastWriteCompletedAt = Date() }
            }
            guard let error else { return }
            KLog.d("⚠️ ws send completion failed: \(error)")
            guard retryOnSendError else { return }
            DispatchQueue.main.async {
                guard let self, self.task === sendingTask else { return }
                self.enqueueOutbound(string)
            }
        }
    }

    private func listenForMessages() {
        // Bind the receive loop to the exact task that created it. A cancelled
        // task may still complete one queued receive callback after connect()
        // has installed a replacement task; accepting that callback would
        // inject stale frames into the new connection and recursively attach a
        // second receive loop to the replacement socket.
        guard let receivingTask = task else { return }
        receivingTask.receive { [weak self, receivingTask] result in
            DispatchQueue.main.async {
                guard let self, self.task === receivingTask else {
                    KLog.d("ℹ️ Ignoring stale WebSocket receive callback")
                    return
                }
                switch result {
                case .success(let message):
                    self.recordInboundActivity()
                    switch message {
                    case .string(let text):
                        if let data = text.data(using: .utf8) { self.onMessage?(data) }
                    case .data(let data):
                        self.onMessage?(data)
                    @unknown default:
                        break
                    }
                    // Message handling can synchronously redirect/logout/recover.
                    guard self.task === receivingTask else { return }
                    self.listenForMessages()
                case .failure:
                    self.recover(reason: "receive_failed")
                }
            }
        }
    }

    // MARK: - Liveness

    private func startLivenessMonitoring() {
        stopLivenessMonitoring()
        lastLivenessAt = Date()
        livenessPingStartedAt = nil
        livenessTimer = Timer.scheduledTimer(
            withTimeInterval: Self.livenessCheckInterval,
            repeats: true
        ) { [weak self] _ in
            self?.checkLiveness()
        }
    }

    private func stopLivenessMonitoring() {
        livenessTimer?.invalidate()
        livenessTimer = nil
        lastLivenessAt = nil
        livenessPingStartedAt = nil
    }

    /// Any inbound frame proves the downlink. It does NOT answer our own
    /// ping: with only the uplink broken the Relay's heartbeats keep arriving,
    /// so only the pong clears an outstanding ping.
    private func recordInboundActivity() {
        lastLivenessAt = Date()
    }

    private func checkLiveness() {
        guard state == .connected,
              let livenessTask = task else { return }
        let now = Date()

        if let pingStarted = livenessPingStartedAt,
           now.timeIntervalSince(pingStarted) > Self.livenessPingTimeout,
           // A pong can be queued behind a congested downlink that is still
           // delivering real data: slow, not dead — up to a hard bound.
           !((isReceivingPayload() || isUploading(now)) && now.timeIntervalSince(pingStarted) < Self.congestedPingTimeout) {
            KLog.d("⚠️ WebSocket liveness ping timed out — replacing stale connection")
            recover(reason: "ping_timeout")
            return
        }

        if let lastLivenessAt,
           now.timeIntervalSince(lastLivenessAt) > Self.livenessTimeout {
            KLog.d("⚠️ WebSocket has been silent for too long — replacing stale connection")
            recover(reason: "transport_silent")
            return
        }

        guard livenessPingStartedAt == nil else { return }
        livenessPingStartedAt = now
        livenessTask.sendPing { [weak self, weak livenessTask] error in
            DispatchQueue.main.async {
                guard let self,
                      self.task === livenessTask else { return }
                self.livenessPingStartedAt = nil
                if let error {
                    KLog.d("⚠️ WebSocket liveness ping failed: \(error)")
                    self.recover(reason: "ping_failed")
                } else {
                    self.lastLivenessAt = Date()
                }
            }
        }
    }

    /// Keep the application-level JSON heartbeat for relay compatibility. The
    /// protocol-level ping above is the actual client-side liveness proof;
    /// successful local writes must never count as proof of connectivity.
    private func startPing() {
        stopPing()
        pingTimer = Timer.scheduledTimer(
            withTimeInterval: Self.pingInterval,
            repeats: true
        ) { [weak self] _ in
            guard let self,
                  self.state == .connected,
                  self.isAuthenticated else { return }
            self.writeString("{\"type\":\"ping\"}", retryOnSendError: false)
        }
    }

    private func stopPing() {
        pingTimer?.invalidate()
        pingTimer = nil
    }

    // MARK: - Reconnect

    private func armPhaseDeadline(after delay: TimeInterval, reason: String) {
        phaseDeadline?.cancel()
        let epoch = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.generation == epoch, !self.isAuthenticated else { return }
            self.recover(reason: reason)
        }
        phaseDeadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Recoverable close keeps the queue and owns one retry. User disconnect
    /// instead retires the transport without scheduling recovery.
    func recover(reason: String) {
        guard !intentionalClose, task != nil else { return }
        #if DEBUG
        recoveryReasons.append(reason)
        #endif
        #if KRAKI_DIAG
        KrakiDiag.record(.connection, [.source: .tag(reason), .count: .int(generation)])
        #endif
        generation += 1
        let oldTask = task, oldSession = session
        task = nil; session = nil
        cleanup()
        oldTask?.cancel(with: .goingAway, reason: nil)
        oldSession?.invalidateAndCancel()
        state = .disconnected
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !intentionalClose, state == .disconnected, task == nil, reconnectWorkItem == nil else { return }
        let epoch = generation

        let now = Date()
        if outageStartedAt == nil { outageStartedAt = now }
        let outage = now.timeIntervalSince(outageStartedAt ?? now)
        let cap = outage < 120 ? Self.reconnectFastCap : (outage < 600 ? 15 : Self.reconnectMax)
        let base = min(reconnectDelay, cap)
        let delay = base * Double.random(in: 0.8...1.2)
        reconnectAttempts += 1
        reconnectDelay = min(reconnectDelay * 2, Self.reconnectMax)
        #if DEBUG
        reconnectScheduledAt.append(now)
        #endif
        onReconnectAttempt?(reconnectAttempts)

        let work = DispatchWorkItem { [weak self] in
            guard let self, self.generation == epoch, !self.intentionalClose else { return }
            self.reconnectWorkItem = nil
            self.connect()
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
        outageStartedAt = nil
        onReconnectAttempt?(0)
        startConnection()
    }

    private func cancelReconnect() {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
    }

    private func cleanup() {
        pendingWrites = 0
        lastWriteCompletedAt = nil
        phaseDeadline?.cancel(); phaseDeadline = nil
        isAuthenticated = false
        stopPing()
        stopLivenessMonitoring()
        stableConnectionWorkItem?.cancel()
        stableConnectionWorkItem = nil
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
        guard webSocketTask === task else {
            KLog.d("ℹ️ Ignoring stale WebSocket open callback")
            return
        }
        KLog.d("✅ WebSocket opened")
        // Opening the TCP/WebSocket handshake is not enough to call a
        // connection stable. Proxies can accept and reset it a few seconds
        // later; resetting here traps us in a 1-second reconnect loop. Keep the
        // accumulated backoff until the socket remains authenticated for the
        // stability interval. The UI can still stop showing reconnecting now.
        onReconnectAttempt?(0)
        armPhaseDeadline(after: Self.authenticationTimeout, reason: "auth_timeout")
        state = .connected
        startPing()
        startLivenessMonitoring()
        listenForMessages()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        guard webSocketTask === task else {
            KLog.d("ℹ️ Ignoring stale WebSocket close callback")
            return
        }
        let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) } ?? "nil"
        KLog.d("🔒 WebSocket closed code=\(closeCode.rawValue) reason=\(reasonStr) intentional=\(intentionalClose) url=\(relayURL)")
        recover(reason: "peer_closed")
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard task === self.task else {
            KLog.d("ℹ️ Ignoring stale WebSocket completion callback")
            return
        }
        guard let error else { return }
        KLog.d("⚠️ WebSocket didCompleteWithError \(error.localizedDescription) intentional=\(intentionalClose) url=\(relayURL)")
        recover(reason: "transport_error")
    }
}
