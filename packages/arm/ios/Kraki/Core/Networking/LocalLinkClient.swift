/// LocalLinkClient — direct loopback transport to the Tentacle running on
/// this Mac (POC).
///
/// Kraki for Mac usually runs a Tentacle on the same machine (built-in helper
/// or a CLI install). Without this, every byte between the two still makes a
/// round trip through the Head. The local link connects straight to the
/// Tentacle's `ws://127.0.0.1:<port>` listener and carries exactly what the
/// Head hop carries for that Tentacle: E2E `{blob, keys}` ciphertext inside a
/// per-connection Pulse StreamSet. Head stays connected for everything else
/// (identity, device list, other computers, push, voice, preferences).
///
/// Trust: the Tentacle proves it holds the key the Head registered for its
/// device ID before we prove ours; both signatures are domain-separated from
/// Head challenge auth so neither side becomes a signing oracle.
///
/// Discovery: `<KRAKI_HOME or ~/.kraki>/local-link.json`, written by the
/// Tentacle. Polled while not linked; the socket's close drives fallback.

#if os(macOS)
import Foundation

/// Client side of the local-link handshake, as a pure state machine.
///
/// The link is trusted only after BOTH proofs: the Tentacle's signature over
/// our nonce must verify against the key the Head registered for it, and only
/// then do we sign its nonce. `ready` is accepted solely in `.authSent`;
/// anything out of order (ready first, a second challenge, Pulse frames before
/// ready, a wrong version) fails closed.
struct LocalLinkHandshake {
    enum Phase: Equatable { case awaitingChallenge, authSent, ready, failed(String) }
    enum Action: Equatable {
        case send([String: String])
        case linkUp
        case deliverPulse(String)
        case fail(String)
        case ignore
    }

    let appId: String
    let tentacleId: String
    let appNonce: String
    /// Verifies the Tentacle's signature over `message` with its registered key.
    let verifyTentacle: (_ message: String, _ signature: String) -> Bool
    /// Signs `message` with this App's registered key.
    let signApp: (_ message: String) -> String?
    private(set) var phase: Phase = .awaitingChallenge

    init(appId: String, tentacleId: String, appNonce: String,
         verifyTentacle: @escaping (String, String) -> Bool,
         signApp: @escaping (String) -> String?) {
        self.appId = appId
        self.tentacleId = tentacleId
        self.appNonce = appNonce
        self.verifyTentacle = verifyTentacle
        self.signApp = signApp
    }

    mutating func receive(_ json: [String: Any]) -> Action {
        if case .failed = phase { return .ignore }
        let type = json["type"] as? String
        switch (phase, type) {
        case (_, "error"):
            return fail("rejected: \(json["code"] as? String ?? "?")")
        case (.awaitingChallenge, "challenge"):
            guard json["v"] as? Int == LocalLinkClient.version,
                  json["tentacleId"] as? String == tentacleId,
                  let nonce = json["nonce"] as? String, !nonce.isEmpty, nonce.count <= 256,
                  let signature = json["signature"] as? String else { return fail("bad challenge") }
            let proof = LocalLinkClient.tentacleProof(appNonce: appNonce, appId: appId, tentacleId: tentacleId)
            guard verifyTentacle(proof, signature) else { return fail("tentacle proof did not verify") }
            guard let mine = signApp(LocalLinkClient.appProof(tentacleNonce: nonce, tentacleId: tentacleId, appId: appId)) else {
                return fail("cannot sign app proof")
            }
            phase = .authSent
            return .send(["type": "auth", "signature": mine])
        case (.authSent, "ready"):
            guard json["v"] as? Int == LocalLinkClient.version else { return fail("bad ready") }
            phase = .ready
            return .linkUp
        case (.ready, "pulse"):
            guard let frame = json["pulse"] as? String else { return .ignore }
            return .deliverPulse(frame)
        default:
            return fail("unexpected \(type ?? "frame") during \(phase)")
        }
    }

    private mutating func fail(_ reason: String) -> Action {
        phase = .failed(reason)
        return .fail(reason)
    }
}

final class LocalLinkClient: NSObject, PulseHost {

    static let version = 1
    static let pollInterval: TimeInterval = 2.0
    static let handshakeTimeout: TimeInterval = 10.0

    struct Discovery: Decodable, Equatable {
        let v: Int
        let port: Int
        let tentacleId: String?
        let pid: Int?
    }

    struct Stats {
        var payloadsIn = 0
        var payloadsOut = 0
        var framesIn = 0
        var framesOut = 0
        var linkUps = 0
        /// Frames the App put on the Head socket addressed to the linked
        /// Tentacle. Should stay flat while the link is up.
        var headFramesToLinked = 0
        /// Head deliveries from the linked Tentacle (marked stale-route).
        var staleHeadDropped = 0
        /// Unconfirmed link commands handed to the Head route on link loss.
        var replayedViaHead = 0
    }

    func noteStaleHeadFrameDropped() { stats.staleHeadDropped += 1 }

    func noteHeadFrame(target: String?) {
        if let target, target == linkedTentacleId { stats.headFramesToLinked += 1 }
    }

    static func tentacleProof(appNonce: String, appId: String, tentacleId: String) -> String {
        "kraki-local-link/v\(version)/tentacle\n\(appNonce)\n\(appId)\n\(tentacleId)"
    }

    static func appProof(tentacleNonce: String, tentacleId: String, appId: String) -> String {
        "kraki-local-link/v\(version)/app\n\(tentacleNonce)\n\(tentacleId)\n\(appId)"
    }

    static var discoveryURL: URL {
        #if DEBUG
        if let home = ProcessInfo.processInfo.environment["KRAKI_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home).appendingPathComponent("local-link.json")
        }
        #endif
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".kraki", isDirectory: true)
            .appendingPathComponent("local-link.json")
    }

    static var enabled: Bool {
        ProcessInfo.processInfo.environment["KRAKI_LOCAL_LINK"] != "0"
    }

    private weak var appState: AppState?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var pulse: PulseManager?
    private var pollTimer: Timer?
    private var handshakeTimer: Timer?
    private var generation = 0
    private var expectedTentacleId: String?
    private var handshake: LocalLinkHandshake?
    private var started = false

    /// The Tentacle currently served over the link (nil when not linked).
    private(set) var linkedTentacleId: String?
    private(set) var stats = Stats()
    private(set) var lastError: String?

    init(appState: AppState) {
        self.appState = appState
        super.init()
    }

    func isLinked(_ tentacleId: String) -> Bool {
        linkedTentacleId == tentacleId
    }

    // MARK: - Lifecycle

    func start() {
        guard Self.enabled, !started else { return }
        started = true
        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
        poll()
    }

    func stop() {
        started = false
        pollTimer?.invalidate()
        pollTimer = nil
        teardown(reason: "stopped")
    }

    private func poll() {
        guard started, task == nil else { return }
        guard let appState, appState.connectionStatus == .connected,
              let appId = appState.deviceId else { return }
        guard let data = try? Data(contentsOf: Self.discoveryURL),
              let discovery = try? JSONDecoder().decode(Discovery.self, from: data),
              discovery.v == Self.version, discovery.port > 0,
              let tentacleId = discovery.tentacleId else { return }
        // Only Tentacles of this account (known to the Head) are eligible:
        // their registered key is what authenticates the loopback peer.
        guard let device = appState.deviceStore.devices[tentacleId], device.role == .tentacle,
              device.publicKey ?? device.encryptionKey != nil else { return }
        connect(port: discovery.port, tentacleId: tentacleId, appId: appId)
    }

    private func connect(port: Int, tentacleId: String, appId: String) {
        guard let url = URL(string: "ws://127.0.0.1:\(port)/") else { return }
        generation += 1
        let epoch = generation
        expectedTentacleId = tentacleId
        let appNonce = Self.randomNonce()
        handshake = makeHandshake(appId: appId, tentacleId: tentacleId, appNonce: appNonce)
        guard handshake != nil else { return }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]  // loopback: never through a proxy
        let session = URLSession(configuration: configuration, delegate: nil, delegateQueue: .main)
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 64 * 1024 * 1024
        self.session = session
        self.task = task
        task.resume()
        receive(epoch: epoch)
        send(["type": "hello", "v": Self.version, "appId": appId, "nonce": appNonce])
        handshakeTimer = Timer.scheduledTimer(withTimeInterval: Self.handshakeTimeout, repeats: false) { [weak self] _ in
            guard let self, self.generation == epoch, self.linkedTentacleId == nil else { return }
            self.fail("handshake timeout")
        }
        KLog.d("🔗 local link: connecting to \(tentacleId.prefix(12)) on :\(port)")
    }

    private func receive(epoch: Int) {
        task?.receive { [weak self] result in
            guard let self, self.generation == epoch else { return }
            switch result {
            case .success(let message):
                let text: String?
                switch message {
                case .string(let string): text = string
                case .data(let data): text = String(data: data, encoding: .utf8)
                @unknown default: text = nil
                }
                if let text { self.handle(text) }
                if self.generation == epoch { self.receive(epoch: epoch) }
            case .failure(let error):
                self.fail("socket: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Handshake + frames

    private func makeHandshake(appId: String, tentacleId: String, appNonce: String) -> LocalLinkHandshake? {
        guard let appState,
              let device = appState.deviceStore.devices[tentacleId],
              let keyB64 = device.publicKey ?? device.encryptionKey,
              let key = try? CryptoManager().importPublicKeyFromSPKI(keyB64) else { return nil }
        weak var auth = appState.authManager
        return LocalLinkHandshake(
            appId: appId, tentacleId: tentacleId, appNonce: appNonce,
            verifyTentacle: { message, signature in
                CryptoManager().verifyChallenge(message, signature: signature, publicKey: key)
            },
            signApp: { message in try? auth?.signLocalLinkProof(message) }
        )
    }

    private func handle(_ text: String) {
        guard var machine = handshake,
              let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fail("malformed frame")
            return
        }
        let action = machine.receive(json)
        handshake = machine
        switch action {
        case .send(let message): send(message)
        case .linkUp: becomeReady()
        case .deliverPulse(let frame):
            stats.framesIn += 1
            pulse?.onFrame(frame)
        case .fail(let reason): fail(reason)
        case .ignore: break
        }
    }

    private func becomeReady() {
        // Only the handshake machine can get here, and only after both proofs.
        guard handshake?.phase == .ready,
              let tentacleId = expectedTentacleId, linkedTentacleId == nil else { return }
        handshakeTimer?.invalidate()
        handshakeTimer = nil
        lastError = nil
        stats.linkUps += 1
        // Order matters: the App forgets its Head-side subscription authority
        // for this Tentacle BEFORE any link data (the session_list barrier) can
        // be decrypted, then the link becomes the route.
        linkedTentacleId = tentacleId
        appState?.localLinkDidChange(tentacleId: tentacleId, linked: true)
        let pulse = PulseManager(host: self)
        self.pulse = pulse
        pulse.onConnected()
        KLog.d("🔗 local link: ready with \(tentacleId.prefix(12)) — bypassing Head")
    }

    private func fail(_ reason: String) {
        lastError = reason
        KLog.d("🔗 local link: \(reason)")
        teardown(reason: reason)
    }

    private func teardown(reason: String) {
        generation += 1
        handshake = nil
        handshakeTimer?.invalidate()
        handshakeTimer = nil
        // Commands the link accepted but the Tentacle never confirmed would be
        // lost with this endpoint. Hand the idempotent ones to the Head route.
        let unacked = pulse?.drainUnackedReplayable() ?? []
        pulse?.onDisconnected()
        pulse = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        if let tentacleId = linkedTentacleId {
            linkedTentacleId = nil
            KLog.d("🔗 local link: down (\(reason)) — \(tentacleId.prefix(12)) back on Head")
            appState?.localLinkDidChange(tentacleId: tentacleId, linked: false)
            if !unacked.isEmpty {
                KLog.d("🔗 local link: re-sending \(unacked.count) unconfirmed command(s) via Head")
                stats.replayedViaHead += unacked.count
                for item in unacked {
                    appState?.pulseManager?.resend(payload: item.payload, target: item.target ?? tentacleId)
                }
            }
        }
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let string = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(string)) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async { self?.fail("send: \(error.localizedDescription)") }
        }
    }

    #if DEBUG
    func debugDrop() { fail("debug drop") }
    #endif

    // MARK: - Outbound

    /// Send E2E ciphertext to the linked Tentacle. False when not linked.
    func sendEncrypted(blob: String, keys: [String: String], to tentacleId: String, connectionScoped: Bool, replayable: Bool = false) -> Bool {
        guard linkedTentacleId == tentacleId, let pulse else { return false }
        stats.payloadsOut += 1
        pulse.sendEncrypted(blob: blob, keys: keys, target: tentacleId, connectionScoped: connectionScoped, fragment: false, replayable: replayable)
        return true
    }

    // MARK: - PulseHost

    func sendPulseFrame(_ b64: String, target: String?) {
        stats.framesOut += 1
        send(["type": "pulse", "pulse": b64])
    }

    func onDelivered(json: String) {
        guard let tentacleId = linkedTentacleId,
              let data = json.data(using: .utf8),
              var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["from"] == nil else { return }
        // The authenticated link is the sender, exactly like the Head's `src`.
        object["src"] = tentacleId
        guard let stamped = try? JSONSerialization.data(withJSONObject: object) else { return }
        stats.payloadsIn += 1
        appState?.messageRouter?.encryptionHandler.submitForDecryption(stamped)
    }

    func onAcked(seqUpTo: UInt64) {}

    func onResetInbound(fromSeq: UInt64, epoch: String) {
        KLog.d("🔗 local link: pulse reset-inbound from=\(fromSeq)")
    }

    func requestConnect() { poll() }
    func requestDisconnect() { teardown(reason: "pulse requested disconnect") }
    func requestPulseRecovery() { fail("pulse progress timeout") }

    // MARK: - Helpers

    private static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
    }

    var diagnostics: [String: Any] {
        [
            "enabled": Self.enabled,
            "discoveryPath": Self.discoveryURL.path,
            "linkedTentacleId": linkedTentacleId ?? NSNull(),
            "payloadsIn": stats.payloadsIn,
            "payloadsOut": stats.payloadsOut,
            "framesIn": stats.framesIn,
            "framesOut": stats.framesOut,
            "linkUps": stats.linkUps,
            "headFramesToLinked": stats.headFramesToLinked,
            "staleHeadDropped": stats.staleHeadDropped,
            "replayedViaHead": stats.replayedViaHead,
            "lastError": lastError ?? NSNull(),
        ]
    }
}
#endif
