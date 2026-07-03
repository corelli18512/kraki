import XCTest

@testable import Pulse

/// Test harness: a deterministic two-endpoint world with a programmable faulty
/// channel and a virtual clock. Port of the TypeScript `World` harness. No real
/// sockets, no real time — every spec §9 failure is reproducible and fast.
final class World {
    enum Dir { case aToB, bToA }

    var now = 0
    let a: Endpoint
    let b: Endpoint

    var deliveredA: [(seq: UInt64, payload: [UInt8])] = []
    var deliveredB: [(seq: UInt64, payload: [UInt8])] = []
    var resetsA: [(fromSeq: UInt64, peerEpoch: String)] = []
    var resetsB: [(fromSeq: UInt64, peerEpoch: String)] = []

    private var linkUp = false
    private var linkAvailable = false
    private var dropCount: [Dir: Int] = [.aToB: 0, .bToA: 0]
    private var dupCount: [Dir: Int] = [.aToB: 0, .bToA: 0]
    private var blackholed = false
    private var reorderBuffer: [(dir: Dir, bytes: [UInt8])]?

    init(a: Endpoint, b: Endpoint) {
        self.a = a
        self.b = b
    }

    // MARK: - Clock

    func advance(_ ms: Int) {
        let target = now + ms
        while true {
            let da = a.nextDeadline() ?? Int.max
            let db = b.nextDeadline() ?? Int.max
            let next = min(da, db)
            if next == Int.max || next > target { break }
            if next > now { now = next }
            pump(a.onTick(now), .aToB)
            pump(b.onTick(now), .bToA)
        }
        now = target
        pump(a.onTick(now), .aToB)
        pump(b.onTick(now), .bToA)
    }

    // MARK: - Link control

    func connect() {
        linkUp = true
        linkAvailable = true
        blackholed = false
        pump(a.onConnected(now), .aToB)
        pump(b.onConnected(now), .bToA)
    }

    func disconnect() {
        linkUp = false
        linkAvailable = false
        pump(a.onDisconnected(now), .aToB)
        pump(b.onDisconnected(now), .bToA)
    }

    func blackhole() {
        blackholed = true
        linkAvailable = false
    }

    func reopen() { connect() }

    // MARK: - Application send

    @discardableResult
    func sendA(_ payload: [UInt8]) -> UInt64 {
        let (seq, effects) = a.send(payload)
        pump(effects, .aToB)
        return seq
    }

    @discardableResult
    func sendB(_ payload: [UInt8]) -> UInt64 {
        let (seq, effects) = b.send(payload)
        pump(effects, .bToA)
        return seq
    }

    // MARK: - Fault programming

    func dropNext(_ dir: Dir, _ n: Int) { dropCount[dir, default: 0] += n }
    func duplicateNext(_ dir: Dir, _ n: Int) { dupCount[dir, default: 0] += n }

    func beginReorder() { reorderBuffer = [] }
    func flushReordered() {
        let buf = reorderBuffer ?? []
        reorderBuffer = nil
        for f in buf.reversed() { deliver(f) }
    }

    // MARK: - Internal plumbing

    private func pump(_ effects: [Effect], _ dir: Dir) {
        for e in effects { applyEffect(e, dir) }
    }

    private func applyEffect(_ e: Effect, _ dir: Dir) {
        let producedByA = (dir == .aToB)
        switch e {
        case let .transmit(bytes):
            enqueue((dir: dir, bytes: bytes))
        case let .deliver(seq, payload):
            if producedByA { deliveredA.append((seq, payload)) }
            else { deliveredB.append((seq, payload)) }
        case let .resetInbound(fromSeq, peerEpoch):
            if producedByA { resetsA.append((fromSeq, peerEpoch)) }
            else { resetsB.append((fromSeq, peerEpoch)) }
        case .open:
            if linkAvailable {
                connect()
            } else {
                pump(producedByA ? a.onDisconnected(now) : b.onDisconnected(now), dir)
            }
        case .close:
            if linkUp || blackholed { disconnect() }
        }
    }

    private func enqueue(_ f: (dir: Dir, bytes: [UInt8])) {
        if reorderBuffer != nil {
            reorderBuffer!.append(f)
            return
        }
        deliver(f)
    }

    private func deliver(_ f: (dir: Dir, bytes: [UInt8])) {
        if !linkUp || blackholed { return }
        if dropCount[f.dir, default: 0] > 0 {
            dropCount[f.dir]! -= 1
            return
        }
        route(f)
        if dupCount[f.dir, default: 0] > 0 {
            dupCount[f.dir]! -= 1
            route(f)
        }
    }

    private func route(_ f: (dir: Dir, bytes: [UInt8])) {
        if f.dir == .aToB {
            pump(b.onBytes(f.bytes, now), .bToA)
        } else {
            pump(a.onBytes(f.bytes, now), .aToB)
        }
    }
}

// MARK: - helpers

func marker(_ n: Int) -> [UInt8] { [UInt8(n & 0xFF)] }

func payloads(_ d: [(seq: UInt64, payload: [UInt8])]) -> [Int] {
    d.map { Int($0.payload.first ?? 255) }
}

func seqs(_ d: [(seq: UInt64, payload: [UInt8])]) -> [UInt64] {
    d.map { $0.seq }
}
