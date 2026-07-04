import XCTest

@testable import Pulse

/// Durable outbox — Swift mirror of the TS durable suite (spec §8.1).
/// Anonymous A/B endpoints, zero kraki concepts. Verifies capability
/// negotiation, the wire durable bit gated on peer support, store/unstore,
/// resume-across-restart, mixed durable/plain, exactly-once, and retention.
final class DurableTests: XCTestCase {
    let params = PulseParams()

    /// Hand-driven pair capturing effects, disk, deliveries. Lets tests inspect
    /// the durable store and simulate a restart without harness clock quirks.
    final class Pair {
        var a: Endpoint
        var b: Endpoint
        var t = 0
        var ackedA: [UInt64] = []
        var deliveredB: [Int] = []
        var diskA: [UInt64: Int] = [:]
        private var linkUp = false

        init(
            aDurable: DurableConfig? = nil, bDurable: DurableConfig? = nil,
            aRestore: Snapshot? = nil, bRestore: Snapshot? = nil
        ) {
            a = Endpoint(epoch: "A", random: { 0.5 }, restore: aRestore, durable: aDurable)
            b = Endpoint(epoch: "B", random: { 0.5 }, restore: bRestore, durable: bDurable)
        }

        private func applyDisk(_ e: Effect) {
            if case let .store(seq, payload) = e { diskA[seq] = Int(payload.first ?? 255) }
            if case let .unstore(seqUpTo) = e { for k in diskA.keys where k <= seqUpTo { diskA[k] = nil } }
        }

        func pump(_ effects: [Effect], _ from: String, dropBHeartbeat: Bool = false) {
            for e in effects {
                if from == "A" { applyDisk(e) }
                if case let .acked(s) = e, from == "A" { ackedA.append(s) }
                if case let .deliver(_, payload, _) = e, from == "B" { deliveredB.append(Int(payload.first ?? 255)) }
                if case let .transmit(bytes) = e {
                    if !linkUp { continue }
                    let fr = decodeFrame(bytes)
                    if dropBHeartbeat, from == "B", case .heartbeat = fr { continue }
                    if from == "A" { pump(b.onBytes(bytes, t), "B", dropBHeartbeat: dropBHeartbeat) }
                    else { pump(a.onBytes(bytes, t), "A", dropBHeartbeat: dropBHeartbeat) }
                }
            }
        }
        func connect() { linkUp = true; pump(a.onConnected(t), "A"); pump(b.onConnected(t), "B") }
        func disconnect() { linkUp = false; pump(a.onDisconnected(t), "A"); pump(b.onDisconnected(t), "B") }
        func tick(_ to: Int, dropBHeartbeat: Bool = false) {
            t = to
            pump(a.onTick(to), "A", dropBHeartbeat: dropBHeartbeat)
            pump(b.onTick(to), "B", dropBHeartbeat: dropBHeartbeat)
        }
        func sendA(_ m: Int, durable: Bool = false) { pump(a.send([UInt8(m)], durable: durable).effects, "A") }
    }

    // 1. Capability negotiation
    func testAdvertisesDurableCapability() {
        func firstHello(_ ep: Endpoint) -> Frame {
            for e in ep.onConnected(0) {
                if case let .transmit(bytes) = e, let fr = decodeFrame(bytes), case .hello = fr { return fr }
            }
            fatalError("no hello")
        }
        if case let .hello(_, _, _, sup, ret) = firstHello(Endpoint(epoch: "A", random: { 0.5 })) {
            XCTAssertFalse(sup); XCTAssertEqual(ret, 0)
        } else { XCTFail() }
        let h = firstHello(Endpoint(epoch: "H", random: { 0.5 }, durable: DurableConfig(supported: true, maxRetentionMs: 2_592_000_000)))
        if case let .hello(_, _, _, sup, ret) = h {
            XCTAssertTrue(sup); XCTAssertEqual(ret, 2_592_000_000)
        } else { XCTFail() }
    }

    // 2. Wire durable bit gated on peer support
    func testWireDurableBitGatedOnPeer() {
        func dataBit(peerSupported: Bool) -> Bool {
            let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
            let peer = Endpoint(epoch: "B", random: { 0.5 }, durable: DurableConfig(supported: peerSupported))
            var peerHello: [UInt8] = []
            for e in peer.onConnected(0) { if case let .transmit(b) = e { peerHello = b } }
            _ = a.onConnected(0)
            _ = a.onBytes(peerHello, 0)
            for e in a.send([1], durable: true).effects {
                if case let .transmit(bytes) = e, let fr = decodeFrame(bytes), case let .data(_, _, _, durable) = fr {
                    return durable
                }
            }
            fatalError("no data")
        }
        XCTAssertTrue(dataBit(peerSupported: true))
        XCTAssertFalse(dataBit(peerSupported: false))
    }

    // 3. Store on durable send; not otherwise
    func testStoreOnlyForDurableSupportedDurableSend() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        var disk: [UInt64: Int] = [:]
        for e in a.send([7], durable: true).effects { if case let .store(s, p) = e { disk[s] = Int(p[0]) } }
        XCTAssertEqual(disk[1], 7)
        // plain send → no store
        XCTAssertFalse(a.send([8]).effects.contains { if case .store = $0 { return true }; return false })
        // not supported → no store even if durable requested
        let b = Endpoint(epoch: "B", random: { 0.5 })
        XCTAssertFalse(b.send([9], durable: true).effects.contains { if case .store = $0 { return true }; return false })
    }

    // 4. Resume across a restart
    func testResumeAcrossRestart() {
        let p = Pair(aDurable: DurableConfig(supported: true), bDurable: DurableConfig(supported: true))
        p.connect()
        p.disconnect()
        p.sendA(9, durable: true)
        XCTAssertEqual(p.diskA[1], 9)
        let snapA = p.a.snapshot()
        let p2 = Pair(
            aDurable: DurableConfig(supported: true), bDurable: DurableConfig(supported: true),
            aRestore: snapA, bRestore: p.b.snapshot())
        p2.diskA = p.diskA
        p2.connect()
        XCTAssertEqual(p2.deliveredB, [9])
    }

    // 6. Unstore only after ack
    func testUnstoreOnlyAfterAck() {
        let p = Pair(aDurable: DurableConfig(supported: true), bDurable: DurableConfig(supported: true))
        p.connect()
        p.sendA(5, durable: true)
        XCTAssertEqual(p.diskA[1], 5)
        p.tick(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(p.deliveredB, [5])
        XCTAssertNil(p.diskA[1])
        XCTAssertEqual(p.ackedA.last, 1)
    }

    func testStoreSurvivesWhileOffline() {
        let p = Pair(aDurable: DurableConfig(supported: true), bDurable: DurableConfig(supported: true))
        p.connect()
        p.disconnect()
        p.sendA(5, durable: true)
        p.tick(params.heartbeatIntervalMs * 3)
        XCTAssertEqual(p.diskA[1], 5)
    }

    // 7. Durable exactly-once under dropped ack
    func testDurableExactlyOnceUnderDroppedAck() {
        let p = Pair(aDurable: DurableConfig(supported: true), bDurable: DurableConfig(supported: true))
        p.connect()
        p.sendA(1, durable: true)
        p.sendA(2, durable: true)
        p.tick(params.heartbeatIntervalMs + 1, dropBHeartbeat: true)
        p.tick(params.heartbeatIntervalMs * 2 + 2)
        XCTAssertEqual(p.deliveredB, [1, 2])
        XCTAssertTrue(p.diskA.isEmpty)
    }

    // 8. Retention expiry
    func testRetentionExpiry() {
        let p = Pair(aDurable: DurableConfig(supported: true, maxRetentionMs: 60_000), bDurable: DurableConfig(supported: true))
        p.connect()
        p.disconnect()
        p.sendA(5, durable: true)
        XCTAssertEqual(p.diskA[1], 5)
        p.tick(59_000)
        XCTAssertNotNil(p.diskA[1])
        p.tick(61_000)
        XCTAssertNil(p.diskA[1])
        XCTAssertEqual(p.a.outboxSize, 0)
    }

    // 9. World-level durable through the fault harness
    func testDurableThroughWorldHarness() {
        let random = { 0.5 }
        let w = World(
            a: Endpoint(epoch: "A", random: random, durable: DurableConfig(supported: true)),
            b: Endpoint(epoch: "B", random: random, durable: DurableConfig(supported: true)))
        w.connect()
        w.disconnect()
        w.sendA([1], durable: true)
        XCTAssertEqual(w.storeA[1], 1)
        w.reopen()
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(payloads(w.deliveredB), [1])
        XCTAssertTrue(w.storeA.isEmpty)
    }

    // Gap-announce livelock fix (the property-test bug): durable-only restart
    // leaves a head gap; the sender must RESET, not livelock resending a hole.
    func testHeadGapAnnouncedNotLivelocked() {
        let p = Pair(aDurable: DurableConfig(supported: true), bDurable: DurableConfig(supported: true))
        p.connect()
        p.disconnect()
        p.sendA(1)                    // plain (seq 1) — lost on restart
        p.sendA(2, durable: true)     // durable (seq 2) — survives
        let snap = p.a.snapshot()
        // Restart A keeping only durable entries → outbox=[seq2], head gap at 1.
        let durableSnap = Snapshot(
            epoch: snap.epoch, sendSeq: snap.sendSeq, outboxBase: snap.outboxBase,
            outbox: snap.outbox.filter { $0.durable },
            recvCursor: snap.recvCursor, peerEpoch: snap.peerEpoch)
        let p2 = Pair(
            aDurable: DurableConfig(supported: true), bDurable: DurableConfig(supported: true),
            aRestore: durableSnap, bRestore: p.b.snapshot())
        p2.diskA = [2: 2]
        p2.connect()
        // Must terminate (no stack overflow) and deliver the durable message.
        p2.tick(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(p2.deliveredB, [2])
    }
}
