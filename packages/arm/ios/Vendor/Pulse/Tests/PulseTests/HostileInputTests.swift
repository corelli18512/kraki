import XCTest

@testable import Pulse

/// Frames come from the relay and from other devices: an endpoint must never
/// trap (Swift integer overflow is a crash) or wedge on hostile values.
final class HostileInputTests: XCTestCase {
    private func connected() -> Endpoint {
        let ep = Endpoint(epoch: "me", random: { 0.5 })
        _ = ep.onConnected(0)
        _ = ep.onFrame(.hello(epoch: "peer", recvEpoch: "", recvCursor: 0, durableSupported: false, maxRetentionMs: 0), 1)
        return ep
    }

    private func delivered(_ effects: [Effect]) -> [UInt64] {
        effects.compactMap { if case let .deliver(seq, _, _, _) = $0 { return seq }; return nil }
    }

    func testHelloWithMaximalCursorDoesNotTrap() {
        let ep = Endpoint(epoch: "me", random: { 0.5 })
        _ = ep.send([1])
        _ = ep.onConnected(0)
        _ = ep.onFrame(.hello(epoch: "peer", recvEpoch: "me", recvCursor: .max, durableSupported: false, maxRetentionMs: 0), 1)
        XCTAssertEqual(ep.sendSeqValue, 1)
    }

    func testResetWithZeroOrHugeOldestIsIgnored() {
        let ep = connected()
        _ = ep.onFrame(.reset(epoch: "peer", oldest: 0), 2)
        _ = ep.onFrame(.reset(epoch: "peer", oldest: .max), 3)
        // The stream is not black-holed: the next in-order frame still arrives.
        XCTAssertEqual(delivered(ep.onFrame(.data(seq: 1, ack: 0, payload: [7], durable: false, coalesceKey: nil), 4)), [1])
    }

    func testDataWithMaximalSeqDoesNotTrap() {
        let ep = connected()
        XCTAssertEqual(delivered(ep.onFrame(.data(seq: .max, ack: .max, payload: [1], durable: false, coalesceKey: nil), 2)), [])
        XCTAssertEqual(delivered(ep.onFrame(.data(seq: 1, ack: 0, payload: [7], durable: false, coalesceKey: nil), 3)), [1])
    }

    func testRandomFramesNeverTrap() {
        var rng = SystemRandomNumberGenerator()
        let ep = connected()
        _ = ep.send([1]); _ = ep.send([2])
        for i in 0..<5_000 {
            let n: UInt64 = [0, 1, 2, .max, .max - 1, UInt64.random(in: 0...UInt64.max, using: &rng)].randomElement(using: &rng)!
            let frame: Frame
            switch i % 5 {
            case 0: frame = .hello(epoch: Bool.random() ? "peer" : "other", recvEpoch: Bool.random() ? "me" : "", recvCursor: n, durableSupported: Bool.random(), maxRetentionMs: n)
            case 1: frame = .data(seq: n, ack: n, payload: [1], durable: false, coalesceKey: nil)
            case 2: frame = .ack(ack: n)
            case 3: frame = .reset(epoch: "peer", oldest: n)
            default: frame = .heartbeat(ack: n)
            }
            _ = ep.onFrame(frame, i)
            _ = ep.onTick(i)
        }
        // Raw bytes too: the decoder must reject garbage without trapping.
        for _ in 0..<5_000 {
            let bytes = (0..<Int.random(in: 0...64)).map { _ in UInt8.random(in: 0...255) }
            _ = ep.onBytes(bytes, 0)
        }
    }
}
