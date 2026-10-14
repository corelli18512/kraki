import XCTest
@testable import Pulse

/// Multi-stream (spec §13) — mirrors `multi-stream.test.ts`. Each stream is a
/// full Endpoint with its own seq/ack/outbox; the v2 wire header's streamId
/// routes frames. The HOL-isolation test proves a live message on stream 0
/// delivers before bulk piled on stream 1.
final class MultiStreamTests: XCTestCase {

    private func tag(_ s: String) -> [UInt8] { Array(s.utf8) }

    // MARK: - Wire streamId header

    func testEncodesStreamIdZeroAsV1() throws {
        // streamId=0 ⇒ legacy v1 header (magic · 0x01 · type), no streamId byte.
        let bytes = try encodeFrame(.heartbeat(ack: 5), streamId: 0)
        XCTAssertEqual(bytes[0], 0xB1)
        XCTAssertEqual(bytes[1], pulseV1Version)
        XCTAssertEqual(bytes[2], 5) // heartbeat
        XCTAssertEqual(bytes.count, 3 + 8)
    }

    func testEncodesNonZeroStreamIdAsV2() throws {
        let bytes = try encodeFrame(.heartbeat(ack: 5), streamId: 7)
        XCTAssertEqual(bytes[0], 0xB1)
        XCTAssertEqual(bytes[1], pulseVersion)
        XCTAssertEqual(bytes[2], 5)
        XCTAssertEqual(bytes[3], 7) // streamId byte
        XCTAssertEqual(bytes.count, 4 + 8)
    }

    func testDecodesV1AsStreamIdZero() throws {
        let v1 = try encodeFrame(.heartbeat(ack: 5), streamId: 0)
        let d = decodeFrameWithStream(v1)
        XCTAssertNotNil(d)
        XCTAssertEqual(d?.streamId, 0)
        XCTAssertEqual(d?.frame, .heartbeat(ack: 5))
    }

    func testDecodesV2WithStreamId() throws {
        let v2 = try encodeFrame(.heartbeat(ack: 5), streamId: 42)
        let d = decodeFrameWithStream(v2)
        XCTAssertEqual(d?.streamId, 42)
        XCTAssertEqual(d?.frame, .heartbeat(ack: 5))
    }

    func testRoundTripsEveryFrameTypeAcrossStreams() throws {
        let frames: [Frame] = [
            .hello(epoch: "e", recvEpoch: "re", recvCursor: 3, durableSupported: true, maxRetentionMs: 0),
            .data(seq: 1, ack: 0, payload: tag("hi"), durable: false, coalesceKey: nil),
            .data(seq: 2, ack: 1, payload: tag("x"), durable: true, coalesceKey: "k"),
            .ack(ack: 9),
            .reset(epoch: "e2", oldest: 4),
            .heartbeat(ack: 7),
        ]
        for f in frames {
            for streamId in [UInt8(0), 1, 255] {
                let d = decodeFrameWithStream(try encodeFrame(f, streamId: streamId))
                XCTAssertEqual(d?.streamId, streamId, "streamId=\(streamId) frame=\(f)")
                XCTAssertEqual(d?.frame, f)
            }
        }
    }

    // MARK: - StreamSet independent seq spaces

    func testEachStreamHasItsOwnSeqStartingAtOne() throws {
        let a0 = Endpoint(epoch: "a0", streamId: 0)
        let a1 = Endpoint(epoch: "a1", streamId: 1)
        let set = StreamSet([a0, a1])
        let r0 = set.send(0, tag("live"))
        let r1 = set.send(1, tag("bulk"))
        XCTAssertEqual(r0.seq, 1)
        XCTAssertEqual(r1.seq, 1) // independent — NOT 2
    }

    // MARK: - HOL isolation (the whole point)

    /// Pre-load 20 bulk messages on stream 1 while DISCONNECTED (they pile into
    /// the outbox), then one live message on stream 0, then connect. The live
    /// message must deliver BEFORE the bulk — proving no head-of-line blocking.
    /// On a single stream the live message (seq 21) would deliver last.
    func testLiveDeliveredBeforeBulk() throws {
        let a0 = Endpoint(epoch: "a0", streamId: 0)
        let a1 = Endpoint(epoch: "a1", streamId: 1)
        let b0 = Endpoint(epoch: "b0", streamId: 0)
        let b1 = Endpoint(epoch: "b1", streamId: 1)

        // Tag → stream attribution for deliveries observed at B.
        var tagToStream: [String: UInt8] = [:]
        for i in 0..<20 {
            let t = "bulk-\(i)"
            tagToStream[t] = 1
            _ = a1.send(tag(t))
        }
        tagToStream["LIVE"] = 0
        _ = a0.send(tag("LIVE"))

        let A = StreamSet([a0, a1])
        let B = StreamSet([b0, b1])

        // Delivery log at B: (stream, tag) in arrival order.
        var deliveredB: [(stream: UInt8, tag: String)] = []
        func record(_ effects: [Effect]) {
            for e in effects {
                if case let .deliver(_, payload, _, _) = e {
                    let t = String(decoding: payload, as: UTF8.self)
                    if let s = tagToStream[t] { deliveredB.append((s, t)) }
                }
            }
        }

        // Pump handshake + pre-loaded resends to quiescence, bidirectionally.
        var aEffects = A.onConnected(0)
        var bEffects = B.onConnected(0)
        record(bEffects)
        for _ in 0..<50 {
            var newB: [Effect] = []
            for e in aEffects where e.isTransmit { newB.append(contentsOf: B.onBytes(e.transmitBytes!, 0)) }
            var newA: [Effect] = []
            for e in bEffects where e.isTransmit { newA.append(contentsOf: A.onBytes(e.transmitBytes!, 0)) }
            record(newB)
            record(newA)
            let more = newA.contains { $0.isTransmit } || newB.contains { $0.isTransmit }
                || aEffects.contains { $0.isTransmit } || bEffects.contains { $0.isTransmit }
            if !more { break }
            aEffects = newA
            bEffects = newB
        }

        // LIVE delivered, all 20 bulk delivered.
        XCTAssertTrue(deliveredB.contains { $0.tag == "LIVE" }, "live message was delivered")
        XCTAssertEqual(deliveredB.filter { $0.stream == 1 }.count, 20)

        // LIVE delivered before the first bulk — the no-HOL guarantee.
        let liveIdx = deliveredB.firstIndex { $0.tag == "LIVE" }
        let firstBulkIdx = deliveredB.firstIndex { $0.stream == 1 }
        XCTAssertNotNil(liveIdx)
        XCTAssertNotNil(firstBulkIdx)
        XCTAssertLessThan(liveIdx!, firstBulkIdx!, "live delivered before first bulk (no HOL blocking)")
    }
}

// MARK: - Effect helpers for the pump above

private extension Effect {
    var isTransmit: Bool {
        if case .transmit = self { return true }
        return false
    }
    var transmitBytes: [UInt8]? {
        if case let .transmit(bytes) = self { return bytes }
        return nil
    }
}
