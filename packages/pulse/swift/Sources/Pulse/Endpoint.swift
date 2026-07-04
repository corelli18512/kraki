import Foundation

/// Effects the core emits for the adapter to carry out. See spec §3.
public enum Effect: Equatable {
    /// Send these bytes as ONE message on the current link.
    case transmit([UInt8])
    /// Hand this payload to the application — in order, exactly once.
    /// Hand this payload to the application — in order, exactly once. `durable`
    /// echoes the sender's per-message durable flag so a bridging app can
    /// preserve the intent when forwarding onto another hop. Pure transport info.
    case deliver(seq: UInt64, payload: [UInt8], durable: Bool)
    /// Begin establishing the link (dial).
    case open
    /// Tear down the current link (dead/stale).
    case close
    /// Inbound history before `fromSeq` is unrecoverable; re-sync there.
    case resetInbound(fromSeq: UInt64, peerEpoch: String)
    /// The peer confirmed receipt of every outbound message with seq ≤ `seqUpTo`
    /// (our outbox pruned up to here). Lets the app resolve "delivered" for what
    /// it sent — e.g. clear/roll back optimistic UI. Observational only.
    case acked(seqUpTo: UInt64)
    /// Persist this outbox entry to durable storage (survives a process
    /// restart). Emitted only by a durable-supported endpoint, only for durable
    /// sends. Carries ONLY seq and bytes — never a destination or routing hint.
    case store(seq: UInt64, payload: [UInt8])
    /// Durable entries with seq ≤ `seqUpTo` are confirmed delivered (or expired)
    /// and may be deleted from durable storage.
    case unstore(seqUpTo: UInt64)
}

public enum LinkState: Equatable {
    case disconnected
    case connected
}

/// Per-endpoint durability capability (advertised at handshake). See spec §8.1.
public struct DurableConfig {
    public var supported: Bool
    public var maxRetentionMs: Int
    public init(supported: Bool, maxRetentionMs: Int = 0) {
        self.supported = supported
        self.maxRetentionMs = maxRetentionMs
    }
}

/// Tunable parameters. Defaults in spec §8.
public struct PulseParams {
    public var heartbeatIntervalMs: Int
    public var deadAfterMs: Int
    public var reconnectBaseMs: Int
    public var reconnectMaxMs: Int
    public var reconnectFactor: Double

    public init(
        heartbeatIntervalMs: Int = 15_000,
        deadAfterMs: Int = 30_000,
        reconnectBaseMs: Int = 1_000,
        reconnectMaxMs: Int = 30_000,
        reconnectFactor: Double = 2
    ) {
        self.heartbeatIntervalMs = heartbeatIntervalMs
        self.deadAfterMs = deadAfterMs
        self.reconnectBaseMs = reconnectBaseMs
        self.reconnectMaxMs = reconnectMaxMs
        self.reconnectFactor = reconnectFactor
    }
}

/// Durable snapshot for restart-durability (spec §10).
public struct Snapshot: Equatable {
    public var epoch: String
    public var sendSeq: UInt64
    public var outboxBase: UInt64
    public var outbox: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int)]
    public var recvCursor: UInt64
    public var peerEpoch: String

    public static func == (l: Snapshot, r: Snapshot) -> Bool {
        l.epoch == r.epoch && l.sendSeq == r.sendSeq && l.outboxBase == r.outboxBase
            && l.recvCursor == r.recvCursor && l.peerEpoch == r.peerEpoch
            && l.outbox.count == r.outbox.count
            && zip(l.outbox, r.outbox).allSatisfy {
                $0.seq == $1.seq && $0.payload == $1.payload && $0.durable == $1.durable
            }
    }
}

/// Endpoint — the sans-I/O core state machine. See spec §2–§7.
///
/// Symmetric and full-duplex: simultaneously producer and consumer. Performs
/// NO I/O — inputs in, `Effect`s out. Deterministic given the same inputs,
/// clock ticks, and injected `random`.
public final class Endpoint {
    private let params: PulseParams
    private let random: () -> Double

    private var epoch: String
    private var sendSeq: UInt64 = 0
    private var outbox: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int)] = []
    private var outboxBase: UInt64 = 0

    private var recvCursor: UInt64 = 0
    private var peerEpoch: String = ""

    private let durable: DurableConfig
    private var peerDurableSupported = false

    private var state: LinkState = .disconnected
    private var lastRecvAt: Int = 0
    private var lastSendAt: Int = 0
    private var reconnectAt: Int?
    private var attempt: Int = 0
    private var clock: Int = 0

    public init(
        epoch: String,
        params: PulseParams = PulseParams(),
        random: @escaping () -> Double = { Double.random(in: 0..<1) },
        restore: Snapshot? = nil,
        durable: DurableConfig? = nil
    ) {
        self.params = params
        self.random = random
        self.epoch = epoch
        self.durable = durable ?? DurableConfig(supported: false)
        if let s = restore { load(s) }
    }

    // MARK: - Inputs

    /// Application wants to send an opaque payload. Returns assigned seq + effects.
    public func send(_ payload: [UInt8], durable durableFlag: Bool = false) -> (seq: UInt64, effects: [Effect]) {
        sendSeq += 1
        let seq = sendSeq
        // Durable only if the app asked AND we can persist (spec §8.1).
        let isDurable = durableFlag && durable.supported
        // Outbox entry created BEFORE any transmit (spec §3 ordering rule).
        outbox.append((seq: seq, payload: payload, durable: isDurable, sentAt: clock))
        var effects: [Effect] = []
        if isDurable { effects.append(.store(seq: seq, payload: payload)) }
        if state == .connected {
            let wireDurable = durableFlag && peerDurableSupported
            effects.append(transmit(.data(seq: seq, ack: recvCursor, payload: payload, durable: wireDurable)))
        }
        return (seq, effects)
    }

    public func onConnected(_ now: Int) -> [Effect] {
        clock = now
        state = .connected
        attempt = 0
        reconnectAt = nil
        lastRecvAt = now
        var effects: [Effect] = []
        effects.append(
            transmit(
                .hello(
                    epoch: epoch, recvEpoch: peerEpoch, recvCursor: recvCursor,
                    durableSupported: durable.supported, maxRetentionMs: UInt64(durable.maxRetentionMs)),
                now: now))
        return effects
    }

    public func onDisconnected(_ now: Int) -> [Effect] {
        clock = now
        state = .disconnected
        attempt += 1
        reconnectAt = now + backoffDelay(attempt)
        return []
    }

    public func onBytes(_ bytes: [UInt8], _ now: Int) -> [Effect] {
        clock = now
        guard let frame = decodeFrame(bytes) else { return [] }  // malformed ⇒ ignore
        lastRecvAt = now
        switch frame {
        case let .hello(epoch, recvEpoch, recvCursor, durableSupported, _):
            return onHello(
                epoch: epoch, recvEpoch: recvEpoch, recvCursor: recvCursor,
                durableSupported: durableSupported, now: now)
        case let .data(seq, ack, payload, durable):
            return onData(seq: seq, ack: ack, payload: payload, durable: durable, now: now)
        case let .ack(ack):
            return onPeerCursor(ack, now)
        case let .reset(epoch, oldest):
            return onReset(epoch: epoch, oldest: oldest)
        case let .heartbeat(ack):
            return onPeerCursor(ack, now)
        }
    }

    public func onTick(_ now: Int) -> [Effect] {
        clock = now
        var effects: [Effect] = []
        expireDurable(now, &effects)
        if state == .connected {
            if now - lastSendAt >= params.heartbeatIntervalMs {
                effects.append(transmit(.heartbeat(ack: recvCursor), now: now))
            }
            if now - lastRecvAt >= params.deadAfterMs {
                effects.append(.close)
            }
        } else if let at = reconnectAt, now >= at {
            reconnectAt = nil
            effects.append(.open)
        }
        return effects
    }

    /// Drop durable outbox entries past the retention window; emit unstore.
    private func expireDurable(_ now: Int, _ effects: inout [Effect]) {
        let ttl = durable.maxRetentionMs
        if !durable.supported || ttl <= 0 { return }
        let expired = outbox.filter { $0.durable && now - $0.sentAt >= ttl }
        if expired.isEmpty { return }
        let expiredSeqs = Set(expired.map { $0.seq })
        outbox.removeAll { expiredSeqs.contains($0.seq) }
        let highest = expired.map { $0.seq }.max() ?? 0
        effects.append(.unstore(seqUpTo: highest))
    }

    // MARK: - Frame handlers

    private func onHello(
        epoch: String, recvEpoch: String, recvCursor: UInt64, durableSupported: Bool, now: Int
    ) -> [Effect] {
        var effects: [Effect] = []
        peerEpoch = epoch
        peerDurableSupported = durableSupported

        // (a) Peer resuming against an epoch we no longer have.
        if !recvEpoch.isEmpty, recvEpoch != self.epoch {
            effects.append(transmit(.reset(epoch: self.epoch, oldest: outboxBase + 1), now: now))
            resendFrom(outboxBase + 1, &effects, now)
            return effects
        }

        // (b) Prune what the peer already has, then resend the rest — announcing
        // any gap at the head of our outbox (e.g. non-durable lost in a restart).
        if recvCursor >= outboxBase {
            pruneOutbox(recvCursor, &effects)
            resendWithGapAnnounce(recvCursor + 1, &effects, now)
        } else {
            effects.append(transmit(.reset(epoch: self.epoch, oldest: outboxBase + 1), now: now))
            resendFrom(outboxBase + 1, &effects, now)
        }
        return effects
    }

    private func onData(seq: UInt64, ack: UInt64, payload: [UInt8], durable: Bool, now: Int) -> [Effect] {
        var effects: [Effect] = []
        pruneOutbox(ack, &effects)  // peer piggybacks its receipt of our outbound
        if seq == recvCursor + 1 {
            recvCursor = seq
            effects.append(.deliver(seq: seq, payload: payload, durable: durable))
        } else if seq <= recvCursor {
            // Duplicate (a resend because our earlier ack was lost). Re-advertise
            // our cursor so the sender learns we have it and stops resending —
            // without this a lost ack can wedge the sender resending forever and
            // it never observes delivery. (Same rationale as TCP's dup-ACK.)
            effects.append(transmit(.ack(ack: recvCursor), now: now))
        } else {
            // hole: seq > recvCursor+1. Ask peer to rewind.
            effects.append(transmit(.ack(ack: recvCursor), now: now))
        }
        return effects
    }

    /// A peer advertised its receive cursor (explicit ACK or idle HEARTBEAT).
    /// Prune what it confirms; if it lags our latest send, resend the gap so
    /// tail-loss and holes self-heal without a reconnect.
    private func onPeerCursor(_ peerCursor: UInt64, _ now: Int) -> [Effect] {
        var effects: [Effect] = []
        pruneOutbox(peerCursor, &effects)
        if peerCursor < sendSeq {
            resendWithGapAnnounce(peerCursor + 1, &effects, now)
        }
        return effects
    }

    private func onReset(epoch: String, oldest: UInt64) -> [Effect] {
        peerEpoch = epoch
        if oldest > recvCursor + 1 {
            // Unavoidable gap: (recvCursor+1 .. oldest-1) are gone forever.
            recvCursor = oldest - 1
            return [.resetInbound(fromSeq: oldest, peerEpoch: epoch)]
        }
        return []
    }

    // MARK: - Helpers

    private func resendFrom(_ fromSeq: UInt64, _ effects: inout [Effect], _ now: Int) {
        for e in outbox where e.seq >= fromSeq {
            let wireDurable = e.durable && peerDurableSupported
            effects.append(
                transmit(.data(seq: e.seq, ack: recvCursor, payload: e.payload, durable: wireDurable), now: now))
        }
    }

    /// Resend from `fromSeq`, first announcing (via RESET) any gap at the head:
    /// if our oldest retained seq is beyond `fromSeq`, those seqs were discarded
    /// (e.g. non-durable lost in a restart) and can never be filled — without the
    /// RESET the peer treats the resend as a hole, re-ACKs, and we livelock.
    private func resendWithGapAnnounce(_ fromSeq: UInt64, _ effects: inout [Effect], _ now: Int) {
        if let oldest = oldestRetainedSeq(), oldest > fromSeq {
            effects.append(transmit(.reset(epoch: epoch, oldest: oldest), now: now))
        }
        resendFrom(fromSeq, &effects, now)
    }

    private func oldestRetainedSeq() -> UInt64? {
        outbox.map { $0.seq }.min()
    }

    private func pruneOutbox(_ ackSeq: UInt64, _ effects: inout [Effect]) {
        if ackSeq <= outboxBase { return }
        let hadDurable = outbox.contains { $0.seq <= ackSeq && $0.durable }
        outbox.removeAll { $0.seq <= ackSeq }
        outboxBase = ackSeq
        // Surface the confirmed delivery floor so the app can resolve/roll back
        // optimistic UI for messages it sent. Observational only.
        effects.append(.acked(seqUpTo: ackSeq))
        if hadDurable { effects.append(.unstore(seqUpTo: ackSeq)) }
    }

    private func transmit(_ frame: Frame, now: Int? = nil) -> Effect {
        if let n = now { lastSendAt = n }
        // encodeFrame only throws on >255-byte epoch; epochs are bounded by the
        // caller, so a failure here is a programming error — trap it.
        return .transmit(try! encodeFrame(frame))
    }

    private func backoffDelay(_ attempt: Int) -> Int {
        let grown = Double(params.reconnectBaseMs)
            * pow(params.reconnectFactor, Double(attempt - 1))
        let ceil = min(Double(params.reconnectMaxMs), grown)
        return Int(random() * (ceil + 1))  // full jitter: uniform [0, ceil]
    }

    // MARK: - Observation

    public func nextDeadline() -> Int? {
        if state == .connected {
            return min(lastSendAt + params.heartbeatIntervalMs, lastRecvAt + params.deadAfterMs)
        }
        return reconnectAt
    }

    public var link: LinkState { state }
    public var sendSeqValue: UInt64 { sendSeq }
    public var recvCursorValue: UInt64 { recvCursor }
    public var outboxSize: Int { outbox.count }

    public func snapshot() -> Snapshot {
        Snapshot(
            epoch: epoch, sendSeq: sendSeq, outboxBase: outboxBase,
            outbox: outbox, recvCursor: recvCursor, peerEpoch: peerEpoch)
    }

    private func load(_ s: Snapshot) {
        epoch = s.epoch
        sendSeq = s.sendSeq
        outboxBase = s.outboxBase
        outbox = s.outbox
        recvCursor = s.recvCursor
        peerEpoch = s.peerEpoch
    }
}
