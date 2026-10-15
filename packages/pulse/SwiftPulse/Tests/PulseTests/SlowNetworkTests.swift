import XCTest

@testable import Pulse

/// Slow-network and periodic-cut scenarios — the timing-sensitive failures of a
/// real long-distance mobile link. Mirrors the TS `slow-network.test.ts`.
///
/// SCOPE NOTE (same as the TS suite): these exercise pulse once bytes flow on a
/// slow/flaky link. They are NOT a test of censorship/DPI resistance — a
/// firewall that blocks by TLS fingerprint or SNI acts before the first byte,
/// below the layer pulse lives at. The "periodic cut" case models a link that
/// keeps getting reset (which pulse survives by reconnecting); it must not be
/// read as defeating a content-inspecting blocker.
final class SlowNetworkTests: XCTestCase {
    let params = PulseParams()

    func makeWorld() -> World {
        let random = { 0.5 }
        return World(
            a: Endpoint(epoch: "node-A", random: random),
            b: Endpoint(epoch: "phone-B", random: random))
    }

    func testHighLatencyDeliversInOrder() {
        let w = makeWorld()
        w.latency(2000)
        w.connect()
        w.sendA(marker(1))
        w.sendA(marker(2))
        XCTAssertEqual(payloads(w.deliveredB), [])
        w.advance(1999)
        XCTAssertEqual(payloads(w.deliveredB), [])
        w.advance(2)
        XCTAssertEqual(payloads(w.deliveredB), [1, 2])
        XCTAssertEqual(seqs(w.deliveredB), [1, 2])
    }

    func testOutboxDrainsAfterDelayedAck() {
        let w = makeWorld()
        w.latency(1000)
        w.connect()
        w.sendA(marker(1))
        w.sendA(marker(2))
        XCTAssertEqual(w.a.outboxSize, 2)
        // Piggybacked ack rides B's idle heartbeat (15s), then 1s back to A.
        w.advance(params.heartbeatIntervalMs + 1000 + 1)
        XCTAssertEqual(w.a.outboxSize, 0)
    }

    func testJitterNeverReordersDelivery() {
        let w = makeWorld()
        w.latency(500)
        w.jitter(300)
        w.connect()
        for i in 1...6 { w.sendA(marker(i)) }
        w.advance(2000)
        XCTAssertEqual(payloads(w.deliveredB), [1, 2, 3, 4, 5, 6])
        XCTAssertEqual(seqs(w.deliveredB), [1, 2, 3, 4, 5, 6])
    }

    func testSlowButHealthyLinkNotFalseKilled() {
        // One-way 12s ⇒ RTT 24s < 30s dead threshold; heartbeats still arrive.
        let w = makeWorld()
        w.latency(12_000)
        w.connect()
        w.advance(120_000)
        XCTAssertEqual(w.a.link, .connected)
        XCTAssertEqual(w.b.link, .connected)
        w.sendA(marker(1))
        w.advance(12_001)
        XCTAssertEqual(payloads(w.deliveredB), [1])
    }

    func testLatencyBeyondDeadThresholdDoesKill() {
        // 31s one-way > 30s: nothing can arrive in time, so tripping is correct.
        let w = makeWorld()
        w.latency(31_000)
        w.connect()
        w.advance(params.deadAfterMs + 1)
        XCTAssertEqual(w.a.link, .disconnected)
    }

    func testTailLossHealsOverSlowLink() {
        let w = makeWorld()
        w.latency(1000)
        w.connect()
        w.sendA(marker(1))
        w.advance(2001)
        w.dropNext(.aToB, 2)
        w.sendA(marker(2))
        w.sendA(marker(3))
        w.advance(1001)
        XCTAssertEqual(payloads(w.deliveredB), [1])
        w.advance(params.heartbeatIntervalMs + 4000)
        XCTAssertEqual(payloads(w.deliveredB), [1, 2, 3])
    }

    func testPeriodicCutAlwaysRecovers() {
        let w = makeWorld()
        w.connect()
        var n = 0
        for cycle in 0..<10 {
            n += 1
            w.sendA(marker(n))
            w.advance(5_000)
            w.disconnect()
            n += 1
            w.sendA(marker(n))
            w.advance(15_000)
            w.reopen()
            w.advance(params.heartbeatIntervalMs + 2_000)
            _ = cycle
        }
        XCTAssertEqual(payloads(w.deliveredB), Array(1...n))
        XCTAssertEqual(seqs(w.deliveredB), (1...n).map { UInt64($0) })
        XCTAssertEqual(w.a.outboxSize, 0)
    }

    func testCutWhileSlowFrameInFlight() {
        let w = makeWorld()
        w.latency(3000)
        w.connect()
        w.sendA(marker(1))
        w.advance(1000)
        w.disconnect()  // cut mid-flight ⇒ in-flight frame lost (fail-stop)
        w.advance(1000)
        XCTAssertEqual(payloads(w.deliveredB), [])
        w.reopen()
        // Resume handshake round trip: B HELLO (3s) + A resend (3s).
        w.advance(6001)
        XCTAssertEqual(payloads(w.deliveredB), [1])
    }
}
