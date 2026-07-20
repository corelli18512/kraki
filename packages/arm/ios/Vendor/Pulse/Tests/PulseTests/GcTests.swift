import XCTest

@testable import Pulse

/// GC + host-driven outbox lifecycle — Swift mirror of the TS gc.test.ts
/// suite (spec §11). Covers introspection getters, disconnectedAtMs tracking,
/// purge/purgeNonDurable, snapshotDurable (spec-correct persistence), and
/// sparse-outbox resend via RESET frames.
final class GcTests: XCTestCase {
    let params = PulseParams()

    // MARK: - 1. Introspection getters

    func testIntrospectionGetters() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        XCTAssertEqual(a.outboxSize, 0)
        XCTAssertEqual(a.durableCount, 0)
        XCTAssertEqual(a.nonDurableCount, 0)
        XCTAssertEqual(a.outboxByteSize, 0)
        XCTAssertNil(a.oldestSentAt)

        _ = a.onTick(1_000)
        _ = a.send([1, 2, 3])                    // non-durable, 3 bytes
        _ = a.send([9, 9, 9, 9], durable: true)  // durable, 4 bytes

        XCTAssertEqual(a.outboxSize, 2)
        XCTAssertEqual(a.durableCount, 1)
        XCTAssertEqual(a.nonDurableCount, 1)
        XCTAssertEqual(a.outboxByteSize, 7)
        XCTAssertEqual(a.oldestSentAt, 1_000)
    }

    // MARK: - 2. disconnectedAtMs

    func testDisconnectedAtNullUntilFirstDisconnect() {
        let a = Endpoint(epoch: "A", random: { 0.5 })
        XCTAssertNil(a.disconnectedAtMs)
        _ = a.onConnected(100)
        XCTAssertNil(a.disconnectedAtMs)
    }

    func testDisconnectedAtStampedOnTransition() {
        let a = Endpoint(epoch: "A", random: { 0.5 })
        _ = a.onConnected(100)
        _ = a.onDisconnected(2_500)
        XCTAssertEqual(a.disconnectedAtMs, 2_500)
    }

    func testDisconnectedAtDoesNotAdvanceOnRepeatedDisconnect() {
        // Adapter idempotency: multiple onClose calls must not reset age.
        let a = Endpoint(epoch: "A", random: { 0.5 })
        _ = a.onConnected(0)
        _ = a.onDisconnected(1_000)
        _ = a.onDisconnected(5_000)
        _ = a.onDisconnected(10_000)
        XCTAssertEqual(a.disconnectedAtMs, 1_000)
    }

    func testDisconnectedAtClearsOnReconnect() {
        let a = Endpoint(epoch: "A", random: { 0.5 })
        _ = a.onConnected(0)
        _ = a.onDisconnected(1_000)
        XCTAssertEqual(a.disconnectedAtMs, 1_000)
        _ = a.onConnected(2_000)
        XCTAssertNil(a.disconnectedAtMs)
    }

    func testDisconnectedAtSurvivesSnapshotRestore() {
        let a = Endpoint(epoch: "A", random: { 0.5 })
        _ = a.onConnected(0)
        _ = a.onDisconnected(1_234)
        let s = a.snapshot()
        let b = Endpoint(epoch: "A", random: { 0.5 }, restore: s)
        XCTAssertEqual(b.disconnectedAtMs, 1_234)
    }

    func testDisconnectedAtPreservedBySnapshotDurable() {
        let a = Endpoint(epoch: "A", random: { 0.5 })
        _ = a.onConnected(0)
        _ = a.onDisconnected(4_567)
        XCTAssertEqual(a.snapshotDurable().disconnectedAtMs, 4_567)
    }

    // MARK: - 3. purgeNonDurable

    func testPurgeNonDurableRemovesOnlyNonDurable() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        _ = a.send([1])                     // seq 1 non-durable
        _ = a.send([2], durable: true)      // seq 2 durable
        _ = a.send([3])                     // seq 3 non-durable
        _ = a.send([4], durable: true)      // seq 4 durable

        let result = a.purgeNonDurable()
        XCTAssertEqual(result.droppedSeqs.sorted(), [1, 3])
        XCTAssertEqual(a.outboxSize, 2)
        XCTAssertEqual(a.durableCount, 2)
        XCTAssertEqual(a.nonDurableCount, 0)

        // Observable purged effect
        var purgedFound = false
        for e in result.effects {
            if case let .purged(dropped, reason) = e {
                XCTAssertEqual(dropped.sorted(), [1, 3])
                XCTAssertEqual(reason, "gc")
                purgedFound = true
            }
            // NO unstore — nothing durable was dropped
            if case .unstore = e { XCTFail("no unstore expected") }
        }
        XCTAssertTrue(purgedFound)
    }

    func testPurgeNonDurableIsNoOpWhenNothingToDrop() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        _ = a.send([1], durable: true)
        let result = a.purgeNonDurable()
        XCTAssertEqual(result.droppedSeqs, [])
        XCTAssertEqual(result.effects.count, 0)
    }

    func testPurgeNonDurableIsIdempotent() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        _ = a.send([1])
        _ = a.send([2], durable: true)
        _ = a.purgeNonDurable()
        let result = a.purgeNonDurable()
        XCTAssertEqual(result.droppedSeqs, [])
    }

    // MARK: - 4. purge(predicate)

    func testPurgeWithPredicate() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        _ = a.onTick(1_000)
        _ = a.send([1], durable: true) // sentAt=1000
        _ = a.onTick(2_000)
        _ = a.send([2], durable: true) // sentAt=2000
        _ = a.onTick(3_000)
        _ = a.send([3], durable: true) // sentAt=3000

        // Drop entries older than 1500 ms
        let result = a.purge({ _, _, sentAt, _ in sentAt < 1_500 }, reason: "age-cap")
        XCTAssertEqual(result.droppedSeqs, [1])
        XCTAssertEqual(a.outboxSize, 2)

        var unstoreFound = false, purgedFound = false
        for e in result.effects {
            if case let .unstore(seqUpTo) = e {
                XCTAssertEqual(seqUpTo, 1)
                unstoreFound = true
            }
            if case let .purged(_, reason) = e {
                XCTAssertEqual(reason, "age-cap")
                purgedFound = true
            }
        }
        XCTAssertTrue(unstoreFound)
        XCTAssertTrue(purgedFound)
    }

    // MARK: - 5. Sparse outbox resend via World harness

    func testPurgedNonDurableInMiddleGapAnnouncedViaReset() {
        // A sends [ND, D, ND, D, ND] offline; purges non-durable; on reconnect
        // resend announces gaps via RESET frames so peer skips lost seqs and
        // still delivers the surviving durables in order.
        let random = { 0.5 }
        let w = World(
            a: Endpoint(epoch: "A", random: random, durable: DurableConfig(supported: true)),
            b: Endpoint(epoch: "B", random: random, durable: DurableConfig(supported: true)))
        w.connect()
        w.disconnect()

        _ = w.a.send([1])                    // seq 1 ND
        _ = w.a.send([2], durable: true)     // seq 2 D
        _ = w.a.send([3])                    // seq 3 ND
        _ = w.a.send([4], durable: true)     // seq 4 D
        _ = w.a.send([5])                    // seq 5 ND

        _ = w.a.purgeNonDurable()

        XCTAssertEqual(w.a.outboxSize, 2)
        XCTAssertEqual(w.a.durableCount, 2)

        w.reopen()
        w.advance(params.heartbeatIntervalMs + 1)

        XCTAssertEqual(payloads(w.deliveredB), [2, 4])
        XCTAssertGreaterThan(w.resetsB.count, 0)
    }

    // MARK: - 6. snapshotDurable

    func testSnapshotDurableSerializesOnlyDurable() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        _ = a.send([1])                     // ND
        _ = a.send([2], durable: true)      // D
        _ = a.send([3])                     // ND
        _ = a.send([4], durable: true)      // D

        let s = a.snapshotDurable()
        let seqs = s.outbox.map { $0.seq }.sorted()
        XCTAssertEqual(seqs, [2, 4])
        XCTAssertEqual(s.sendSeq, 4)  // sendSeq preserved, no collisions
    }

    func testLegacySnapshotPreservesEverything() {
        let a = Endpoint(epoch: "A", random: { 0.5 }, durable: DurableConfig(supported: true))
        _ = a.send([1])
        _ = a.send([2], durable: true)
        let s = a.snapshot()
        let seqs = s.outbox.map { $0.seq }.sorted()
        XCTAssertEqual(seqs, [1, 2])
    }

    func testRestoreFromSnapshotDurableDeliversDurablesOnly() {
        let random = { 0.5 }
        let w1 = World(
            a: Endpoint(epoch: "A", random: random, durable: DurableConfig(supported: true)),
            b: Endpoint(epoch: "B", random: random, durable: DurableConfig(supported: true)))
        w1.connect()
        w1.disconnect()
        _ = w1.a.send([1])                     // ND — lost
        _ = w1.a.send([2], durable: true)      // D — survives
        _ = w1.a.send([3])                     // ND — lost
        _ = w1.a.send([4], durable: true)      // D — survives

        let snap = w1.a.snapshotDurable()

        let w2 = World(
            a: Endpoint(epoch: "A", random: random, restore: snap, durable: DurableConfig(supported: true)),
            b: Endpoint(epoch: "B", random: random, restore: w1.b.snapshot(), durable: DurableConfig(supported: true)))
        w2.connect()
        w2.advance(params.heartbeatIntervalMs + 1)
        XCTAssertEqual(payloads(w2.deliveredB), [2, 4])
    }

    // MARK: - 7. hub-style GC scenario

    func testHubGcKeepsOutboxBoundedForStalePeer() {
        let active = Endpoint(epoch: "active", random: { 0.5 }, durable: DurableConfig(supported: true))
        let stale = Endpoint(epoch: "stale", random: { 0.5 }, durable: DurableConfig(supported: true))
        _ = active.onConnected(0)
        _ = stale.onConnected(0)
        _ = stale.onDisconnected(1_000)  // never comes back

        for i in 0..<100 {
            _ = active.send([UInt8(i & 0xff)])
            _ = stale.send([UInt8(i & 0xff)])
        }
        XCTAssertEqual(active.outboxSize, 100)
        XCTAssertEqual(stale.outboxSize, 100)

        _ = active.onTick(6 * 60_000)
        _ = stale.onTick(6 * 60_000)
        let result = stale.purgeNonDurable(reason: "gc-idle-5m")
        XCTAssertEqual(result.droppedSeqs.count, 100)
        XCTAssertEqual(stale.outboxSize, 0)
        // active peer's outbox is untouched
        XCTAssertEqual(active.outboxSize, 100)
    }
}
