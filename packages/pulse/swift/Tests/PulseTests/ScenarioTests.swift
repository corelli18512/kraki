import XCTest

@testable import Pulse

/// Real-world failure catalog — the same scenarios as the TypeScript suite
/// (`ts/src/__tests__/scenarios.test.ts`), proving the Swift core has identical
/// behavior. See spec §9. Runs under the virtual-clock `World` harness.
final class ScenarioTests: XCTestCase {
    let params = PulseParams()

    func makeWorld() -> World {
        let random = { 0.5 }
        return World(
            a: Endpoint(epoch: "node-A", random: random),
            b: Endpoint(epoch: "phone-B", random: random))
    }

    // CLEAN-DISCONNECT
    func testCleanDisconnectLosesNothing() {
        let w = makeWorld()
        w.connect()
        w.sendA(marker(1))
        w.sendA(marker(2))
        XCTAssertEqual(payloads(w.deliveredB), [1, 2])
        w.disconnect()
        w.sendA(marker(3))
        w.sendA(marker(4))
        XCTAssertEqual(payloads(w.deliveredB), [1, 2])
        w.reopen()
        XCTAssertEqual(payloads(w.deliveredB), [1, 2, 3, 4])
        XCTAssertEqual(seqs(w.deliveredB), [1, 2, 3, 4])
    }

    func testOutboxDrainsAfterAck() {
        let w = makeWorld()
        w.connect()
        w.sendA(marker(1))
        w.disconnect()
        w.sendA(marker(2))
        XCTAssertGreaterThan(w.a.outboxSize, 0)
        w.reopen()
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(w.a.outboxSize, 0)
    }

    // PRODUCE-WHILE-DOWN
    func testProduceWhileDownFlushesOnResume() {
        let w = makeWorld()
        w.connect()
        w.disconnect()
        for i in 1...5 { w.sendA(marker(i)) }
        XCTAssertEqual(payloads(w.deliveredB), [])
        w.reopen()
        XCTAssertEqual(payloads(w.deliveredB), [1, 2, 3, 4, 5])
    }

    func testContiguousSeqsOffline() {
        let w = makeWorld()
        w.connect()
        let s1 = w.sendA(marker(1))
        w.disconnect()
        let s2 = w.sendA(marker(2))
        let s3 = w.sendA(marker(3))
        XCTAssertEqual([s1, s2, s3], [1, 2, 3])
    }

    // OFFLINE-CATCHUP
    func testLongBacklogCatchup() {
        let w = makeWorld()
        w.connect()
        w.disconnect()
        for i in 1...100 { w.sendA(marker(i)) }
        w.reopen()
        XCTAssertEqual(w.deliveredB.count, 100)
        XCTAssertEqual(seqs(w.deliveredB), (1...100).map { UInt64($0) })
    }

    // ABRUPT-KILL
    func testAbruptKillResendsInFlight() {
        let w = makeWorld()
        w.connect()
        w.sendA(marker(1))
        w.dropNext(.aToB, 1)
        w.sendA(marker(2))
        w.disconnect()
        XCTAssertEqual(payloads(w.deliveredB), [1])
        w.reopen()
        XCTAssertEqual(payloads(w.deliveredB), [1, 2])
    }

    // TAIL-LOSS
    func testTailLossHealsViaHeartbeat() {
        let w = makeWorld()
        w.connect()
        w.sendA(marker(1))
        w.dropNext(.aToB, 2)
        w.sendA(marker(2))
        w.sendA(marker(3))
        XCTAssertEqual(payloads(w.deliveredB), [1])
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(payloads(w.deliveredB), [1, 2, 3])
    }

    // DUPLICATE
    func testDuplicateNeverDoubleDelivers() {
        let w = makeWorld()
        w.connect()
        w.duplicateNext(.aToB, 3)
        w.sendA(marker(1))
        w.sendA(marker(2))
        w.sendA(marker(3))
        XCTAssertEqual(payloads(w.deliveredB), [1, 2, 3])
        XCTAssertEqual(seqs(w.deliveredB), [1, 2, 3])
    }

    // REORDER
    func testReorderDeliversInOrderOnly() {
        let w = makeWorld()
        w.connect()
        w.beginReorder()
        w.sendA(marker(1))
        w.sendA(marker(2))
        w.sendA(marker(3))
        w.flushReordered()
        let s = seqs(w.deliveredB)
        for (i, v) in s.enumerated() { XCTAssertEqual(v, UInt64(i + 1)) }
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(payloads(w.deliveredB), [1, 2, 3])
    }

    // HALF-OPEN
    func testHalfOpenDetectedAndClosed() {
        let w = makeWorld()
        w.connect()
        w.sendA(marker(1))
        XCTAssertEqual(payloads(w.deliveredB), [1])
        w.blackhole()
        w.advance(params.deadAfterMs - 1)
        XCTAssertEqual(w.a.link, .connected)
        w.advance(2)
        XCTAssertEqual(w.a.link, .disconnected)
    }

    func testHalfOpenRecoversWhenPathReturns() {
        let w = makeWorld()
        w.connect()
        w.blackhole()
        w.advance(params.deadAfterMs + 1)
        w.sendA(marker(1))
        w.reopen()
        XCTAssertEqual(payloads(w.deliveredB), [1])
    }

    // RECONNECT policy
    func testReconnectsForeverNoCap() {
        let w = makeWorld()
        w.connect()
        w.disconnect()
        w.advance(10 * 60_000)
        XCTAssertNotNil(w.a.nextDeadline())
        w.sendA(marker(1))
        w.reopen()
        XCTAssertEqual(payloads(w.deliveredB), [1])
    }

    func testFirstRetryWithinBaseCeiling() {
        let w = makeWorld()
        w.connect()
        let t0 = w.now
        w.disconnect()
        let deadline = w.a.nextDeadline()
        XCTAssertNotNil(deadline)
        XCTAssertGreaterThanOrEqual(deadline! - t0, 0)
        XCTAssertLessThanOrEqual(deadline! - t0, params.reconnectBaseMs)
    }

    // TOO-OLD
    func testTooOldSurfacesResetInbound() {
        let random = { 0.5 }
        let w = World(
            a: Endpoint(epoch: "node-A", random: random),
            b: Endpoint(epoch: "phone-B", random: random))
        w.connect()
        for i in 1...5 { w.sendA(marker(i)) }
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(w.a.outboxSize, 0)
        w.disconnect()

        let wiped = World(
            a: Endpoint(epoch: "node-A", random: random, restore: w.a.snapshot()),
            b: Endpoint(epoch: "B-reborn", random: random))
        wiped.connect()
        XCTAssertEqual(wiped.resetsB.count, 1)
        XCTAssertEqual(wiped.resetsB.first?.fromSeq, 6)
    }

    // RESTART-DURABLE
    func testRestartDurableResendsUnacked() {
        let random = { 0.5 }
        let w = World(
            a: Endpoint(epoch: "node-A", random: random),
            b: Endpoint(epoch: "phone-B", random: random))
        w.connect()
        w.sendA(marker(1))
        w.disconnect()
        w.sendA(marker(2))
        let snap = w.a.snapshot()

        let w2 = World(
            a: Endpoint(epoch: "node-A", random: random, restore: snap),
            b: Endpoint(epoch: "phone-B", random: random, restore: w.b.snapshot()))
        w2.connect()
        XCTAssertEqual(payloads(w2.deliveredB), [2])
    }

    // WEDGE-FREE
    func testWedgeFreeUnderChurn() {
        let w = makeWorld()
        w.connect()
        var expected = 0
        for round in 0..<8 {
            expected += 1
            w.sendA(marker(expected))
            if round % 2 == 0 {
                w.disconnect()
                expected += 1
                w.sendA(marker(expected))
                w.reopen()
            } else {
                w.blackhole()
                w.advance(params.deadAfterMs + 1)
                expected += 1
                w.sendA(marker(expected))
                w.reopen()
            }
            w.advance(params.heartbeatIntervalMs + 1)
        }
        XCTAssertEqual(payloads(w.deliveredB), (1...expected).map { $0 })
        XCTAssertEqual(w.a.outboxSize, 0)
    }

    // BIDIRECTIONAL
    func testBidirectionalIndependentSeqSpaces() {
        let w = makeWorld()
        w.connect()
        w.sendA(marker(10))
        w.sendB(marker(20))
        w.sendB(marker(21))
        XCTAssertEqual(payloads(w.deliveredB), [10])
        XCTAssertEqual(payloads(w.deliveredA), [20, 21])
        XCTAssertEqual(seqs(w.deliveredB), [1])
        XCTAssertEqual(seqs(w.deliveredA), [1, 2])
    }

    func testBidirectionalRecoversBothDirections() {
        let w = makeWorld()
        w.connect()
        w.disconnect()
        w.sendA(marker(1))
        w.sendB(marker(2))
        w.reopen()
        XCTAssertEqual(payloads(w.deliveredB), [1])
        XCTAssertEqual(payloads(w.deliveredA), [2])
    }

    // ACKED — sender observes confirmed delivery of what it sent

    func testAckedFiresAfterPeerConfirms() {
        let w = makeWorld()
        w.connect()
        XCTAssertEqual(w.ackedA, [])
        w.sendA(marker(1))
        w.sendA(marker(2))
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(w.ackedA.last, 2)
        XCTAssertEqual(w.a.outboxSize, 0)
    }

    func testAckedDoesNotFireWhileUndelivered() {
        let w = makeWorld()
        w.connect()
        w.disconnect()
        w.sendA(marker(1))
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(w.ackedA, [])
        XCTAssertEqual(w.a.outboxSize, 1)
        w.reopen()
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(w.ackedA.last, 1)
    }

    func testAckedFloorMonotonic() {
        let w = makeWorld()
        w.connect()
        w.sendA(marker(1))
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(w.ackedA.last, 1)
        w.sendA(marker(2))
        w.sendA(marker(3))
        w.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(w.ackedA.last, 3)
        for i in 1..<w.ackedA.count {
            XCTAssertTrue(w.ackedA[i] > w.ackedA[i - 1])
        }
    }

    /// A duplicate at the receiver (our earlier ack was lost) must trigger a
    /// re-ACK so the sender learns delivery and confirms exactly once. Driven at
    /// the Endpoint level to isolate the property from harness clock mechanics.
    func testResentMessageConfirmsExactlyOnce() {
        let a = Endpoint(epoch: "A", random: { 0.5 })
        let b = Endpoint(epoch: "B", random: { 0.5 })
        var t = 0
        var ackedA: [UInt64] = []
        var deliveredB: [Int] = []
        func pump(_ effects: [Effect], _ from: String, dropBHeartbeat: Bool = false) {
            for e in effects {
                switch e {
                case let .acked(seqUpTo) where from == "A":
                    ackedA.append(seqUpTo)
                case let .deliver(_, payload, _) where from == "B":
                    deliveredB.append(Int(payload.first ?? 255))
                case let .transmit(bytes):
                    let fr = decodeFrame(bytes)
                    if dropBHeartbeat, from == "B", case .heartbeat = fr { continue }
                    if from == "A" { pump(b.onBytes(bytes, t), "B") }
                    else { pump(a.onBytes(bytes, t), "A") }
                default:
                    break
                }
            }
        }
        pump(a.onConnected(t), "A")
        pump(b.onConnected(t), "B")
        pump(a.send(marker(1)).effects, "A")
        XCTAssertEqual(deliveredB, [1])

        t = 15_000
        pump(a.onTick(t), "A")
        pump(b.onTick(t), "B", dropBHeartbeat: true)  // lose B's first cursor
        XCTAssertEqual(ackedA, [])

        t = 30_000
        pump(a.onTick(t), "A")
        pump(b.onTick(t), "B")  // next heartbeat confirms
        XCTAssertEqual(deliveredB, [1])
        XCTAssertEqual(ackedA.last, 1)
        XCTAssertEqual(ackedA.filter { $0 == 1 }.count, 1)
    }
}

