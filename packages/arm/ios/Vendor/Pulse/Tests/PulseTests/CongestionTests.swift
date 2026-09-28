import XCTest

@testable import Pulse

/// A lagging but advancing peer cursor is data in flight on a slow link, not
/// loss. Mirrors the TS `congestion.test.ts`.
final class CongestionTests: XCTestCase {
    private let interval = PulseParams().heartbeatIntervalMs

    private func dataSeqs(_ effects: [Effect]) -> [UInt64] {
        effects.compactMap {
            guard case .transmit(let bytes) = $0, case .data(let seq, _, _, _, _)? = decodeFrame(bytes) else { return nil }
            return seq
        }
    }

    func testNeverResendsInFlightFramesWhileThePeerCatchesUp() {
        let a = Endpoint(epoch: "a", random: { 0.5 })
        _ = a.onConnected(0)
        for i in 0..<100 { _ = a.send([UInt8(i)]) }
        var resent = 0
        var t = interval
        while t <= 45_000 {
            resent += dataSeqs(a.onFrame(.heartbeat(ack: UInt64(t / 500)), t)).count
            resent += dataSeqs(a.onTick(t + 1)).count
            t += interval
        }
        XCTAssertEqual(resent, 0)
    }

    func testRepairsACursorThatStoppedAdvancing() {
        let a = Endpoint(epoch: "a", random: { 0.5 })
        _ = a.onConnected(0)
        for i in 0..<5 { _ = a.send([UInt8(i)]) }
        XCTAssertEqual(dataSeqs(a.onFrame(.heartbeat(ack: 2), 1_000)), [])
        XCTAssertEqual(dataSeqs(a.onTick(1_000 + interval)), [3, 4, 5])
    }

    func testStillRepairsAtOnceOnAnExplicitHoleAck() {
        let a = Endpoint(epoch: "a", random: { 0.5 })
        _ = a.onConnected(0)
        for i in 0..<3 { _ = a.send([UInt8(i)]) }
        XCTAssertEqual(dataSeqs(a.onFrame(.ack(ack: 1), 10)), [2, 3])
    }
}
