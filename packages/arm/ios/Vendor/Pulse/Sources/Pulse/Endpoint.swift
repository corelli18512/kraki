import Foundation

/// Effects the core emits for the adapter to carry out. See spec §3.
public enum Effect: Equatable {
    /// Send these bytes as ONE message on the current link.
    case transmit([UInt8])
    /// Hand this payload to the application — in order, exactly once.
    /// Hand this payload to the application — in order, exactly once. `durable`
    /// echoes the sender's per-message durable flag so a bridging app can
    /// preserve the intent when forwarding onto another hop. Pure transport info.
    case deliver(seq: UInt64, payload: [UInt8], durable: Bool, coalesceKey: String?)
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
    /// Observational: the host purged outbox entries via `purge`/`purgeNonDurable`.
    /// `droppedSeqs` are the seqs that were removed. `reason` echoes the caller
    /// for logs/metrics. Peers are told to skip these seqs on the next resend
    /// (as RESET frames), so delivery is not re-attempted.
    case purged(droppedSeqs: [UInt64], reason: String)
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

/// Durable snapshot for restart-durability (spec §10). `disconnectedAtMs` is
/// preserved across snapshot/restore so a host GC policy that keys on
/// "disconnected too long" survives restart (spec §11). Older snapshots
/// without the field restore to nil (back-compat).
public struct Snapshot: Equatable {
    public var epoch: String
    public var sendSeq: UInt64
    public var outboxBase: UInt64
    public var outbox: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int, coalesceKey: String?)]
    public var recvCursor: UInt64
    public var peerEpoch: String
    public var disconnectedAtMs: Int?

    public static func == (l: Snapshot, r: Snapshot) -> Bool {
        l.epoch == r.epoch && l.sendSeq == r.sendSeq && l.outboxBase == r.outboxBase
            && l.recvCursor == r.recvCursor && l.peerEpoch == r.peerEpoch
            && l.disconnectedAtMs == r.disconnectedAtMs
            && l.outbox.count == r.outbox.count
            && zip(l.outbox, r.outbox).allSatisfy {
                $0.seq == $1.seq && $0.payload == $1.payload && $0.durable == $1.durable
                    && $0.coalesceKey == $1.coalesceKey
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
    private var outbox: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int, coalesceKey: String?)] = []
    private var outboxBase: UInt64 = 0

    private var recvCursor: UInt64 = 0
    private var peerEpoch: String = ""

    private let durable: DurableConfig
    private var peerDurableSupported = false
    /// Which logical stream this endpoint owns on a shared link (spec §13).
    /// Default 0 = legacy single stream. Carried in every frame's v2 header so
    /// a peer StreamSet can route it; an independent seq/ack/outbox makes a
    /// bulk stream unable to head-of-line block a live stream.
    private let streamId: UInt8

    private var state: LinkState = .disconnected
    private var lastRecvAt: Int = 0
    private var lastSendAt: Int = 0
    private var reconnectAt: Int?
    private var attempt: Int = 0
    /// Peer cursor currently being repaired. Duplicate ACKs for the same cursor
    /// are suppressed until it advances or the bounded retry deadline expires.
    private var repairCursor: UInt64?
    private var repairSentAt: Int = 0
    private var clock: Int = 0
    /// Wall-clock ms of the most recent Connected → Disconnected transition,
    /// or nil while Connected. Preserved across snapshot/restore so a host
    /// GC policy keyed on "disconnected too long" survives restart. See §11.
    private var disconnectedAt: Int?

    public init(
        epoch: String,
        params: PulseParams = PulseParams(),
        random: @escaping () -> Double = { Double.random(in: 0..<1) },
        restore: Snapshot? = nil,
        durable: DurableConfig? = nil,
        streamId: UInt8 = 0
    ) {
        self.params = params
        self.random = random
        self.epoch = epoch
        self.durable = durable ?? DurableConfig(supported: false)
        self.streamId = streamId
        if let s = restore { load(s) }
    }

    // MARK: - Inputs

    /// Application wants to send an opaque payload. Returns assigned seq + effects.
    public func send(_ payload: [UInt8], durable durableFlag: Bool = false, coalesceKey: String? = nil) -> (seq: UInt64, effects: [Effect]) {
        // 1. Mutual exclusion check
        if coalesceKey != nil && durableFlag {
            fatalError("coalesceKey requires durable=false")
        }
        // 2. Key length validation (>255 UTF-8 bytes → reject before state mutation)
        if let key = coalesceKey, key.utf8.count > 255 {
            fatalError("coalesceKey exceeds 255 bytes")
        }
        var effects: [Effect] = []
        // 3. Coalesce on send: drop old outbox entries with same key
        if let key = coalesceKey {
            var droppedSeqs: [UInt64] = []
            var kept: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int, coalesceKey: String?)] = []
            for e in outbox {
                if e.coalesceKey == key {
                    droppedSeqs.append(e.seq)
                } else {
                    kept.append(e)
                }
            }
            outbox = kept
            if !droppedSeqs.isEmpty {
                effects.append(.purged(droppedSeqs: droppedSeqs, reason: "coalesced:\(key)"))
            }
        }
        sendSeq += 1
        let seq = sendSeq
        // Durable only if the app asked AND we can persist (spec §8.1).
        let isDurable = durableFlag && durable.supported
        // Outbox entry created BEFORE any transmit (spec §3 ordering rule).
        outbox.append((seq: seq, payload: payload, durable: isDurable, sentAt: clock, coalesceKey: coalesceKey))
        if isDurable { effects.append(.store(seq: seq, payload: payload)) }
        if state == .connected {
            let wireDurable = durableFlag && peerDurableSupported
            effects.append(transmit(.data(seq: seq, ack: recvCursor, payload: payload, durable: wireDurable, coalesceKey: coalesceKey)))
        }
        return (seq, effects)
    }

    public func onConnected(_ now: Int) -> [Effect] {
        clock = now
        state = .connected
        disconnectedAt = nil
        attempt = 0
        reconnectAt = nil
        repairCursor = nil
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
        repairCursor = nil
        // Stamp the disconnect time only on the first Connected → Disconnected
        // transition — repeated calls (e.g. adapter idempotency) must not reset
        // the age a host GC policy is measuring against. See §11.
        if disconnectedAt == nil { disconnectedAt = now }
        attempt += 1
        reconnectAt = now + backoffDelay(attempt)
        return []
    }

    public func onBytes(_ bytes: [UInt8], _ now: Int) -> [Effect] {
        clock = now
        guard let frame = decodeFrame(bytes) else { return [] }  // malformed ⇒ ignore
        return onFrame(frame, now)
    }

    /// Handle an already-decoded frame. Public so a StreamSet (which demuxes
    /// by streamId before dispatching) can feed each per-stream endpoint its
    /// own frames without re-decoding. Sets `lastRecvAt` (any frame is
    /// liveness evidence, spec §6).
    public func onFrame(_ frame: Frame, _ now: Int) -> [Effect] {
        clock = now
        lastRecvAt = now
        switch frame {
        case let .hello(epoch, recvEpoch, recvCursor, durableSupported, _):
            return onHello(
                epoch: epoch, recvEpoch: recvEpoch, recvCursor: recvCursor,
                durableSupported: durableSupported, now: now)
        case let .data(seq, ack, payload, durable, coalesceKey):
            return onData(seq: seq, ack: ack, payload: payload, durable: durable, coalesceKey: coalesceKey, now: now)
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
            // A repair batch can itself be lost. Retry it on a bounded timer,
            // but do not let every duplicate ACK clone the retained suffix.
            if let cursor = repairCursor,
               cursor < sendSeq,
               now - repairSentAt >= params.heartbeatIntervalMs {
                repairSentAt = now
                resendWithGapAnnounce(cursor + 1, &effects, now)
            }
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
        // Detect peer cold-restart (RESTART-FRESH, spec §9): the peer previously
        // used a different epoch, now advertises a new one. All state we hold
        // about the peer's send-side (recvCursor, expected-next-seq) refers to
        // a stream that no longer exists. If we don't drop it, the peer's fresh
        // seq=1..N frames will be silently dropped by onData's duplicate-check
        // (seq <= recvCursor). Surface the discontinuity so the app learns
        // history was dropped, then accept the peer's new stream from seq=1.
        if !peerEpoch.isEmpty, epoch != peerEpoch {
            self.recvCursor = 0
            effects.append(.resetInbound(fromSeq: 1, peerEpoch: epoch))
        }
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

    private func onData(seq: UInt64, ack: UInt64, payload: [UInt8], durable: Bool, coalesceKey: String?, now: Int) -> [Effect] {
        var effects: [Effect] = []
        pruneOutbox(ack, &effects)  // peer piggybacks its receipt of our outbound
        if seq == recvCursor + 1 {
            recvCursor = seq
            effects.append(.deliver(seq: seq, payload: payload, durable: durable, coalesceKey: coalesceKey))
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
        // ACKs are cumulative. An older ACK after a higher cursor was already
        // pruned is stale/in-flight and must never rewind recovery.
        if peerCursor < outboxBase { return effects }
        pruneOutbox(peerCursor, &effects)
        if peerCursor >= sendSeq {
            repairCursor = nil
            return effects
        }
        // A burst behind one missing DATA can queue many identical ACKs before
        // the first repair crosses the wire. Emit one bounded repair batch;
        // onTick retries it if that batch itself is lost.
        if repairCursor == peerCursor { return effects }
        repairCursor = peerCursor
        repairSentAt = now
        resendWithGapAnnounce(peerCursor + 1, &effects, now)
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
        // outbox may be SPARSE after purge / snapshotDurable restore (host GC
        // dropped some seqs mid-stream). Walk entries in seq order and inject a
        // RESET before any seq that isn't contiguous with the last one we sent
        // — it advances the peer's recvCursor over the gap so the following
        // DATA frame delivers. Without this the peer holds the gap open,
        // ACKs its old cursor, and we live-lock.
        let entries = outbox.filter { $0.seq >= fromSeq }.sorted { $0.seq < $1.seq }
        var expectedNext: UInt64 = fromSeq
        for e in entries {
            if e.seq > expectedNext {
                effects.append(transmit(.reset(epoch: epoch, oldest: e.seq), now: now))
            }
            let wireDurable = e.durable && peerDurableSupported
            effects.append(
                transmit(.data(seq: e.seq, ack: recvCursor, payload: e.payload, durable: wireDurable, coalesceKey: e.coalesceKey), now: now))
            expectedNext = e.seq + 1
        }
    }

    /// Resend from `fromSeq`, first announcing (via RESET) any gap at the head:
    /// if our oldest retained seq is beyond `fromSeq`, those seqs were discarded
    /// (e.g. non-durable lost in a restart) and can never be filled — without the
    /// RESET the peer treats the resend as a hole, re-ACKs, and we livelock.
    private func resendWithGapAnnounce(_ fromSeq: UInt64, _ effects: inout [Effect], _ now: Int) {
        // resendFrom already injects RESET exactly where the sparse outbox first
        // skips sequence space. A second head RESET duplicates the same control.
        resendFrom(fromSeq, &effects, now)
    }

    private func pruneOutbox(_ ackSeq: UInt64, _ effects: inout [Effect]) {
        if ackSeq <= outboxBase { return }
        // Clamp peer state to the highest seq this incarnation has assigned.
        let clamped = min(ackSeq, sendSeq)
        if clamped <= outboxBase { return }
        let hadDurable = outbox.contains { $0.seq <= clamped && $0.durable }
        outbox.removeAll { $0.seq <= clamped }
        outboxBase = clamped
        if let cursor = repairCursor, clamped > cursor { repairCursor = nil }
        // Surface the confirmed delivery floor so the app can resolve/roll back
        // optimistic UI for messages it sent. Observational only.
        effects.append(.acked(seqUpTo: clamped))
        if hadDurable { effects.append(.unstore(seqUpTo: clamped)) }
    }

    private func transmit(_ frame: Frame, now: Int? = nil) -> Effect {
        if let n = now { lastSendAt = n }
        // encodeFrame only throws on >255-byte epoch; epochs are bounded by the
        // caller, so a failure here is a programming error — trap it.
        return .transmit(try! encodeFrame(frame, streamId: streamId))
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
            let repairDeadline = repairCursor.map { _ in repairSentAt + params.heartbeatIntervalMs } ?? Int.max
            return min(
                lastSendAt + params.heartbeatIntervalMs,
                lastRecvAt + params.deadAfterMs,
                repairDeadline)
        }
        return reconnectAt
    }

    public var link: LinkState { state }
    /// The logical stream this endpoint owns on a shared link (spec §13).
    public var stream: UInt8 { streamId }
    public var sendSeqValue: UInt64 { sendSeq }
    public var recvCursorValue: UInt64 { recvCursor }
    public var outboxSize: Int { outbox.count }

    /// Cumulative bytes of payload currently in the outbox — for host memory
    /// accounting / GC decisions. Does not include per-entry overhead.
    /// See spec §11.
    public var outboxByteSize: Int {
        outbox.reduce(0) { $0 + $1.payload.count }
    }
    /// Count of durable-flagged entries in the outbox.
    public var durableCount: Int {
        outbox.reduce(0) { $0 + ($1.durable ? 1 : 0) }
    }
    /// Count of non-durable entries in the outbox.
    public var nonDurableCount: Int {
        outbox.reduce(0) { $0 + ($1.durable ? 0 : 1) }
    }
    /// The clock reading (host ms) when the OLDEST outbox entry was first sent.
    /// Nil if the outbox is empty. Lets a host GC "entries older than N ms".
    public var oldestSentAt: Int? {
        outbox.map { $0.sentAt }.min()
    }
    /// Wall-clock ms of the most recent Connected → Disconnected transition,
    /// or nil while Connected. Preserved across snapshot/restore. See §11.
    public var disconnectedAtMs: Int? { disconnectedAt }

    /// Remove outbox entries matching `predicate`. Returns dropped seqs and the
    /// effects the removal produced (an `unstore` for any durable rows the
    /// adapter should now delete from disk, plus an observational `purged`).
    ///
    /// This is the host's escape-hatch for GC. See spec §11.
    public func purge(
        _ predicate: (_ seq: UInt64, _ durable: Bool, _ sentAt: Int, _ byteLength: Int) -> Bool,
        reason: String = "host"
    ) -> (droppedSeqs: [UInt64], effects: [Effect]) {
        var droppedSeqs: [UInt64] = []
        var hadDurable = false
        var maxDroppedDurableSeq: UInt64 = 0
        var kept: [(seq: UInt64, payload: [UInt8], durable: Bool, sentAt: Int, coalesceKey: String?)] = []
        for e in outbox {
            if predicate(e.seq, e.durable, e.sentAt, e.payload.count) {
                droppedSeqs.append(e.seq)
                if e.durable {
                    hadDurable = true
                    if e.seq > maxDroppedDurableSeq { maxDroppedDurableSeq = e.seq }
                }
            } else {
                kept.append(e)
            }
        }
        outbox = kept
        var effects: [Effect] = []
        if hadDurable { effects.append(.unstore(seqUpTo: maxDroppedDurableSeq)) }
        if !droppedSeqs.isEmpty { effects.append(.purged(droppedSeqs: droppedSeqs, reason: reason)) }
        return (droppedSeqs, effects)
    }

    /// Convenience: drop all non-durable outbox entries. See spec §11.
    public func purgeNonDurable(reason: String = "gc") -> (droppedSeqs: [UInt64], effects: [Effect]) {
        purge({ _, durable, _, _ in !durable }, reason: reason)
    }

    /// Snapshot the endpoint including ALL outbox entries (durable +
    /// non-durable). Preserves pre-0.2.0 behavior. Use `snapshotDurable()`
    /// for the spec-correct "durable-only" form when persisting across a
    /// process restart.
    public func snapshot() -> Snapshot {
        Snapshot(
            epoch: epoch, sendSeq: sendSeq, outboxBase: outboxBase,
            outbox: outbox, recvCursor: recvCursor, peerEpoch: peerEpoch,
            disconnectedAtMs: disconnectedAt)
    }

    /// Snapshot only durable outbox entries. Non-durable are by definition
    /// "in-memory only, may be lost on restart" (spec §8.1). Persisting them
    /// violates that contract AND causes unbounded memory growth if the host
    /// writes snapshots aggressively. On restore the outbox may be sparse in
    /// seq space; `resendFrom` handles gaps via RESET frames automatically.
    public func snapshotDurable() -> Snapshot {
        Snapshot(
            epoch: epoch, sendSeq: sendSeq, outboxBase: outboxBase,
            outbox: outbox.filter { $0.durable },
            recvCursor: recvCursor, peerEpoch: peerEpoch,
            disconnectedAtMs: disconnectedAt)
    }

    private func load(_ s: Snapshot) {
        epoch = s.epoch
        sendSeq = s.sendSeq
        outboxBase = s.outboxBase
        outbox = s.outbox
        recvCursor = s.recvCursor
        peerEpoch = s.peerEpoch
        disconnectedAt = s.disconnectedAtMs
    }
}
