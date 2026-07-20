/// PulseManager — reliable multi-stream transport integration.
///
/// One WebSocket carries two independent Pulse streams:
///   stream 0 = live/control and every Arm-originated command
///   stream 1 = inbound bulk history/TRACE/attachment responses
///
/// Each stream owns an independent epoch, seq/ack space, outbox and receive
/// cursor. This prevents a large history or attachment response from blocking
/// subscription ACKs, card actions, deltas, aborts, or other live traffic.

import Foundation
import Pulse

final class PulseManager {

    static let liveStream: UInt8 = 0
    static let bulkStream: UInt8 = 1

    private let streams: StreamSet
    private let live: Endpoint
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
    #endif

    private var tickTimer: Timer?
    private static let tickInterval: TimeInterval = 5.0
    private var nowMs: Int {
        Int((CFAbsoluteTimeGetCurrent() + kCFAbsoluteTimeIntervalSince1970) * 1000)
    }

    init(host: PulseHost) {
        self.host = host
        let base = UUID().uuidString
        let live = Endpoint(
            epoch: "\(base):live",
            params: PulseParams(heartbeatIntervalMs: 15_000),
            restore: nil,
            durable: nil,
            streamId: Self.liveStream
        )
        let bulk = Endpoint(
            epoch: "\(base):bulk",
            params: PulseParams(heartbeatIntervalMs: 15_000),
            restore: nil,
            durable: nil,
            streamId: Self.bulkStream
        )
        self.live = live
        self.streams = StreamSet([live, bulk])
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
        guard let data = Data(base64Encoded: b64) else { return }
        handle(streams.onBytes([UInt8](data), nowMs))
    }

    // MARK: - Connection lifecycle

    func onConnected() {
        handle(streams.onConnected(nowMs))
        scheduleTick()
    }

    func onDisconnected() {
        _ = streams.onDisconnected(nowMs)
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
        tickTimer = Timer.scheduledTimer(
            withTimeInterval: Self.tickInterval, repeats: false
        ) { [weak self] _ in
            guard let self else { return }
            self.handle(self.streams.onTick(self.nowMs))
            self.scheduleTick()
        }
    }

    private func cancelTick() {
        tickTimer?.invalidate()
        tickTimer = nil
    }

    // MARK: - Effects

    private func handle(_ effects: [Effect]) {
        for effect in effects {
            switch effect {
            case .transmit(let bytes):
                let b64 = Data(bytes).base64EncodedString()
                let target = recoverTarget(forBytes: bytes)
                host?.sendPulseFrame(b64, target: target)
            case .deliver(_, let payload, _, _):
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
                host?.requestConnect()
            case .close:
                host?.requestDisconnect()
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
}
