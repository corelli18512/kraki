import Foundation

/// Effects the core emits for the adapter to carry out. See spec §3.
public enum Effect: Equatable {
    /// Send these bytes as ONE message on the current link.
    case transmit([UInt8])
    /// Hand this payload to the application — in order, exactly once.
    case deliver(seq: UInt64, payload: [UInt8])
    /// Begin establishing the link (dial).
    case open
    /// Tear down the current link (dead/stale).
    case close
    /// Inbound history before `fromSeq` is unrecoverable; re-sync there.
    case resetInbound(fromSeq: UInt64, peerEpoch: String)
}

public enum LinkState: Equatable {
    case disconnected
    case connected
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
    public var outbox: [(seq: UInt64, payload: [UInt8])]
    public var recvCursor: UInt64
    public var peerEpoch: String

    public static func == (l: Snapshot, r: Snapshot) -> Bool {
        l.epoch == r.epoch && l.sendSeq == r.sendSeq && l.outboxBase == r.outboxBase
            && l.recvCursor == r.recvCursor && l.peerEpoch == r.peerEpoch
            && l.outbox.count == r.outbox.count
            && zip(l.outbox, r.outbox).allSatisfy { $0.seq == $1.seq && $0.payload == $1.payload }
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
    private var outbox: [(seq: UInt64, payload: [UInt8])] = []
    private var outboxBase: UInt64 = 0

    private var recvCursor: UInt64 = 0
    private var peerEpoch: String = ""

    private var state: LinkState = .disconnected
    private var lastRecvAt: Int = 0
    private var lastSendAt: Int = 0
    private var reconnectAt: Int?
    private var attempt: Int = 0

    public init(
        epoch: String,
        params: PulseParams = PulseParams(),
        random: @escaping () -> Double = { Double.random(in: 0..<1) },
        restore: Snapshot? = nil
    ) {
        self.params = params
        self.random = random
        self.epoch = epoch
        if let s = restore { load(s) }
    }

    // MARK: - Inputs

    /// Application wants to send an opaque payload. Returns assigned seq + effects.
    public func send(_ payload: [UInt8]) -> (seq: UInt64, effects: [Effect]) {
        sendSeq += 1
        let seq = sendSeq
        // Outbox entry created BEFORE any transmit (spec §3 ordering rule).
        outbox.append((seq: seq, payload: payload))
        var effects: [Effect] = []
        if state == .connected {
            effects.append(transmit(.data(seq: seq, ack: recvCursor, payload: payload)))
        }
        return (seq, effects)
    }

    public func onConnected(_ now: Int) -> [Effect] {
        state = .connected
        attempt = 0
        reconnectAt = nil
        lastRecvAt = now
        var effects: [Effect] = []
        effects.append(
            transmit(.hello(epoch: epoch, recvEpoch: peerEpoch, recvCursor: recvCursor), now: now))
        return effects
    }

    public func onDisconnected(_ now: Int) -> [Effect] {
        state = .disconnected
        attempt += 1
        reconnectAt = now + backoffDelay(attempt)
        return []
    }

    public func onBytes(_ bytes: [UInt8], _ now: Int) -> [Effect] {
        guard let frame = decodeFrame(bytes) else { return [] }  // malformed ⇒ ignore
        lastRecvAt = now
        switch frame {
        case let .hello(epoch, recvEpoch, recvCursor):
            return onHello(epoch: epoch, recvEpoch: recvEpoch, recvCursor: recvCursor, now: now)
        case let .data(seq, ack, payload):
            return onData(seq: seq, ack: ack, payload: payload, now: now)
        case let .ack(ack):
            return onPeerCursor(ack, now)
        case let .reset(epoch, oldest):
            return onReset(epoch: epoch, oldest: oldest)
        case let .heartbeat(ack):
            return onPeerCursor(ack, now)
        }
    }

    public func onTick(_ now: Int) -> [Effect] {
        var effects: [Effect] = []
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

    // MARK: - Frame handlers

    private func onHello(epoch: String, recvEpoch: String, recvCursor: UInt64, now: Int) -> [Effect] {
        var effects: [Effect] = []
        peerEpoch = epoch

        // (a) Peer resuming against an epoch we no longer have.
        if !recvEpoch.isEmpty, recvEpoch != self.epoch {
            effects.append(transmit(.reset(epoch: self.epoch, oldest: outboxBase + 1), now: now))
            resendFrom(outboxBase + 1, &effects, now)
            return effects
        }

        // (b) Prune what the peer already has, then resend the rest.
        if recvCursor >= outboxBase {
            pruneOutbox(recvCursor)
            resendFrom(recvCursor + 1, &effects, now)
        } else {
            effects.append(transmit(.reset(epoch: self.epoch, oldest: outboxBase + 1), now: now))
            resendFrom(outboxBase + 1, &effects, now)
        }
        return effects
    }

    private func onData(seq: UInt64, ack: UInt64, payload: [UInt8], now: Int) -> [Effect] {
        pruneOutbox(ack)  // peer piggybacks its receipt of our outbound
        var effects: [Effect] = []
        if seq == recvCursor + 1 {
            recvCursor = seq
            effects.append(.deliver(seq: seq, payload: payload))
        } else if seq <= recvCursor {
            // duplicate — safe to drop, never re-deliver
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
        pruneOutbox(peerCursor)
        var effects: [Effect] = []
        if peerCursor < sendSeq {
            resendFrom(peerCursor + 1, &effects, now)
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
            effects.append(transmit(.data(seq: e.seq, ack: recvCursor, payload: e.payload), now: now))
        }
    }

    private func pruneOutbox(_ ackSeq: UInt64) {
        if ackSeq <= outboxBase { return }
        outbox.removeAll { $0.seq <= ackSeq }
        if ackSeq > outboxBase { outboxBase = ackSeq }
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
