/// PulseManager — reliable multi-stream transport integration.
///
/// One WebSocket carries two independent Pulse streams:
///   stream 0 = live/control and every Arm-originated command
///   stream 1 = inbound bulk history/TRACE/attachment responses
///
/// Each stream owns an independent epoch, seq/ack space, outbox and receive
/// cursor. This separates logical ordering/replay, not byte-level HOL: a large
/// WebSocket message can still delay complete-message delivery on either stream.

import Foundation
import Pulse

final class PulseManager {

    static let liveStream: UInt8 = 0
    static let bulkStream: UInt8 = 1

    private var streams: StreamSet
    private var live: Endpoint
    private weak var host: PulseHost?

    /// DATA delivery targets retained per stream and seq so repair/reconnect
    /// retransmits preserve the original unicast destination. Live and bulk
    /// have independent seq spaces, so seq alone is not a sufficient key.
    private var targetByStream: [UInt8: [UInt64: String]] = [:]
    /// Commands such as abort are scoped to the current WebSocket connection.
    /// If their frame was not ACKed before disconnect, purge it rather than
    /// replaying it into a later turn after reconnect.
    private var connectionScopedLiveSeqs = Set<UInt64>()

    #if DEBUG
    var liveOutboxSizeForTesting: Int { live.outboxSize }
    var connectionScopedCountForTesting: Int { connectionScopedLiveSeqs.count }
    var clockForTesting: Int?
    var tickActiveForTesting: Bool { tickTimer != nil && authenticated }
    func tickForTesting() { tick(epoch: generation) }
    #endif

    private var tickTimer: Timer?
    private var authenticated = false
    private var generation = 0
    private static let tickInterval: TimeInterval = 5.0
    /// COMPLETE logical messages and native WS ping/pong have different clocks.
    /// Allow bounded slow-message progress; pongs cannot mask a stuck stream forever.
    static let logicalProgressTimeoutMs = 120_000
    /// A stream silent past its deadline while the socket keeps delivering
    /// frames on the other stream is starved by a congested FIFO link, not
    /// stuck. Tolerate that (frames within `transportActiveWindowMs`) up to an
    /// absolute bound so a genuinely wedged stream is still recovered.
    static let transportActiveWindowMs = 30_000
    static let starvedStreamMaxMs = 300_000
    private var lastFrameAtMs: Int?
    /// Last time a DATA payload (not a heartbeat) was delivered to the app.
    private(set) var lastDeliveryAt: Date?
    private var starvedSinceMs: Int?
    private var nowMs: Int {
        #if DEBUG
        if let clockForTesting { return clockForTesting }
        #endif
        return Int((CFAbsoluteTimeGetCurrent() + kCFAbsoluteTimeIntervalSince1970) * 1000)
    }

    init(host: PulseHost) {
        self.host = host
        (self.live, self.streams) = Self.makeEndpoints()
    }

    private static func makeEndpoints() -> (Endpoint, StreamSet) {
        let base = UUID().uuidString
        let live = Endpoint(
            epoch: "\(base):live",
            params: PulseParams(heartbeatIntervalMs: 15_000, deadAfterMs: Self.logicalProgressTimeoutMs),
            restore: nil,
            durable: nil,
            streamId: Self.liveStream
        )
        let bulk = Endpoint(
            epoch: "\(base):bulk",
            params: PulseParams(heartbeatIntervalMs: 15_000, deadAfterMs: Self.logicalProgressTimeoutMs),
            restore: nil,
            durable: nil,
            streamId: Self.bulkStream
        )
        return (live, StreamSet([live, bulk]))
    }

    /// Logout is an identity boundary, unlike backgrounding/network loss.
    /// Retire every queued command and cursor; the next login must advertise a
    /// fresh epoch and must never resend ciphertext addressed by the old user.
    func resetForIdentityChange() {
        authenticated = false
        generation += 1
        cancelTick()
        targetByStream.removeAll()
        connectionScopedLiveSeqs.removeAll()
        (live, streams) = Self.makeEndpoints()
    }

    // MARK: - Send

    /// Every Arm-originated command uses stream 0. Only the Tentacle emits bulk
    /// range/TRACE/attachment responses on stream 1.
    func sendEncrypted(
        blob: String,
        keys: [String: String],
        target: String?,
        connectionScoped: Bool = false
    ) {
        guard let payload = try? JSONSerialization.data(
            withJSONObject: ["blob": blob, "keys": keys]
        ) else { return }
        sendPayload(payload, target: target, connectionScoped: connectionScoped)
    }

    /// Head-bound control is plaintext by design: the authenticated head is the
    /// recipient, so there is no peer E2E key. Pulse still supplies ordering,
    /// acknowledgement and reconnect semantics.
    func sendControl(_ message: [String: Any], target: String) -> Bool {
        guard JSONSerialization.isValidJSONObject(message),
              let payload = try? JSONSerialization.data(withJSONObject: message) else {
            return false
        }
        sendPayload(payload, target: target, connectionScoped: true)
        return true
    }

    private func sendPayload(
        _ payload: Data,
        target: String?,
        connectionScoped: Bool
    ) {
        let (seq, effects) = live.send([UInt8](payload), durable: false, coalesceKey: nil)
        if let target {
            targetByStream[Self.liveStream, default: [:]][seq] = target
        }
        if connectionScoped { connectionScopedLiveSeqs.insert(seq) }
        handle(effects)
    }

    // MARK: - Receive

    /// Decode the v1/v2 wire header once and dispatch to the owning stream.
    func onFrame(_ b64: String) {
        guard authenticated else { return }
        guard let data = Data(base64Encoded: b64) else { return }
        lastFrameAtMs = nowMs
        handle(streams.onBytes([UInt8](data), nowMs))
    }

    // MARK: - Connection lifecycle

    func onConnected() {
        guard !authenticated else { return }
        authenticated = true
        generation += 1
        lastFrameAtMs = nowMs
        starvedSinceMs = nil
        handle(streams.onConnected(nowMs))
        scheduleTick()
    }

    func onDisconnected() {
        if authenticated {
            authenticated = false
            generation += 1
            _ = streams.onDisconnected(nowMs)
        }
        // Even an attempt that never authenticated must retire scoped commands
        // queued during that attempt. Don't rearm endpoint reconnect deadlines.
        if !connectionScopedLiveSeqs.isEmpty {
            let scoped = connectionScopedLiveSeqs
            let purged = live.purge(
                { seq, _, _, _ in scoped.contains(seq) },
                reason: "connection-scoped-disconnect"
            )
            handle(purged.effects)
            connectionScopedLiveSeqs.subtract(purged.droppedSeqs)
        }
        cancelTick()
    }

    // MARK: - Tick

    private func scheduleTick() {
        cancelTick()
        guard authenticated else { return }
        let epoch = generation
        tickTimer = Timer.scheduledTimer(
            withTimeInterval: Self.tickInterval, repeats: false
        ) { [weak self] _ in
            self?.tick(epoch: epoch)
        }
    }

    private func tick(epoch: Int) {
        guard authenticated, generation == epoch else { return }
        let effects = streams.onTick(nowMs)
        if !effects.contains(where: { if case .close = $0 { return true }; return false }) { starvedSinceMs = nil }
        handle(effects)
        guard authenticated, generation == epoch else { return }
        scheduleTick()
    }

    private func cancelTick() {
        tickTimer?.invalidate()
        tickTimer = nil
    }

    // MARK: - Effects

    private func handle(_ effects: [Effect]) {
        let epoch = generation
        for effect in effects {
            guard generation == epoch else { return }
            switch effect {
            case .transmit(let bytes):
                let b64 = Data(bytes).base64EncodedString()
                let target = recoverTarget(forBytes: bytes)
                host?.sendPulseFrame(b64, target: target)
            case .deliver(_, let payload, _, _):
                lastDeliveryAt = Date()
                host?.onDelivered(json: String(decoding: payload, as: UTF8.self))
            case .acked(let seqUpTo):
                // Arm business sends currently exist only on stream 0. Stream 1
                // has no outbound DATA, so an acked effect is necessarily live.
                pruneTargets(stream: Self.liveStream, through: seqUpTo)
                connectionScopedLiveSeqs = connectionScopedLiveSeqs.filter { $0 > seqUpTo }
                host?.onAcked(seqUpTo: seqUpTo)
            case .resetInbound(let fromSeq, let epoch):
                host?.onResetInbound(fromSeq: fromSeq, epoch: epoch)
            case .open:
                // WS owns physical retries. Never let stream deadlines replace auth.
                break
            case .close:
                guard authenticated else { return }
                let now = nowMs
                if let last = lastFrameAtMs, now - last < Self.transportActiveWindowMs {
                    let since = starvedSinceMs ?? now
                    starvedSinceMs = since
                    if now - since < Self.starvedStreamMaxMs - Self.logicalProgressTimeoutMs { continue }
                }
                onDisconnected()
                host?.requestPulseRecovery()
                return // one physical recovery; discard remaining old effects
            case .purged(let droppedSeqs, _):
                // Arm sends only on live. Keep target retention consistent if a
                // future GC/coalescing policy drops an unacked command.
                var liveTargets = targetByStream[Self.liveStream] ?? [:]
                for seq in droppedSeqs {
                    liveTargets.removeValue(forKey: seq)
                    connectionScopedLiveSeqs.remove(seq)
                }
                targetByStream[Self.liveStream] = liveTargets.isEmpty ? nil : liveTargets
            case .store, .unstore:
                break  // Arm is not durable-supported.
            }
        }
    }

    private func recoverTarget(forBytes bytes: [UInt8]) -> String? {
        guard let decoded = decodeFrameWithStream(bytes) else { return nil }
        guard case .data(let seq, _, _, _, _) = decoded.frame else { return nil }
        return targetByStream[decoded.streamId]?[seq]
    }

    private func pruneTargets(stream: UInt8, through seqUpTo: UInt64) {
        guard var targets = targetByStream[stream] else { return }
        targets = targets.filter { $0.key > seqUpTo }
        targetByStream[stream] = targets.isEmpty ? nil : targets
    }
}

// MARK: - PulseHost

protocol PulseHost: AnyObject {
    func sendPulseFrame(_ b64: String, target: String?)
    func onDelivered(json: String)
    func onAcked(seqUpTo: UInt64)
    func onResetInbound(fromSeq: UInt64, epoch: String)
    func requestConnect()
    func requestDisconnect()
    func requestPulseRecovery()
}

extension PulseHost {
    func requestPulseRecovery() { requestDisconnect() }
}
