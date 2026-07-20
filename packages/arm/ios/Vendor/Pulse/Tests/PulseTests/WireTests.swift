import XCTest

@testable import Pulse

/// Wire codec conformance — driven by the SHARED fixtures (`wire.json`, the
/// same file the TypeScript suite loads). Byte-exact agreement here is what
/// guarantees a TS producer and a Swift consumer interoperate on the wire.
/// See `spec/FIXTURES.md`.
final class WireTests: XCTestCase {

    /// A fixture field value: either a string (numbers/hex/epochs) or a bool
    /// (durable flags). The shared wire.json mixes both.
    enum FieldValue: Decodable {
        case string(String)
        case bool(Bool)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let b = try? c.decode(Bool.self) { self = .bool(b) }
            else { self = .string(try c.decode(String.self)) }
        }
        var str: String { if case let .string(s) = self { return s }; return "" }
        var bool: Bool { if case let .bool(b) = self { return b }; return false }
    }

    struct Fixtures: Decodable {
        struct F: Decodable {
            let name: String
            let type: String
            let fields: [String: FieldValue]
            let hex: String
        }
        struct M: Decodable {
            let name: String
            let hex: String
        }
        let frames: [F]
        let malformed: [M]
    }

    func loadFixtures() throws -> Fixtures {
        guard let url = Bundle.module.url(forResource: "wire", withExtension: "json") else {
            XCTFail("wire.json resource not found")
            fatalError()
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Fixtures.self, from: data)
    }

    func frameFor(_ f: Fixtures.F) -> Frame {
        let x = f.fields
        switch f.type {
        case "hello":
            return .hello(
                epoch: x["epoch"]!.str, recvEpoch: x["recvEpoch"]!.str,
                recvCursor: UInt64(x["recvCursor"]!.str)!,
                durableSupported: x["durableSupported"]?.bool ?? false,
                maxRetentionMs: UInt64(x["maxRetentionMs"]?.str ?? "0")!)
        case "data":
            return .data(
                seq: UInt64(x["seq"]!.str)!, ack: UInt64(x["ack"]!.str)!,
                payload: unhex(x["payloadHex"]!.str),
                durable: x["durable"]?.bool ?? false,
                coalesceKey: x["coalesceKey"]?.str)
        case "ack":
            return .ack(ack: UInt64(x["ack"]!.str)!)
        case "reset":
            return .reset(epoch: x["epoch"]!.str, oldest: UInt64(x["oldest"]!.str)!)
        case "heartbeat":
            return .heartbeat(ack: UInt64(x["ack"]!.str)!)
        default:
            fatalError("unknown fixture type \(f.type)")
        }
    }

    func testEncodesToExactBytes() throws {
        let fx = try loadFixtures()
        for f in fx.frames {
            let bytes = try encodeFrame(frameFor(f))
            XCTAssertEqual(hex(bytes), f.hex, "encode mismatch for \(f.name)")
        }
    }

    func testDecodesBackToFrame() throws {
        let fx = try loadFixtures()
        for f in fx.frames {
            let decoded = decodeFrame(unhex(f.hex))
            XCTAssertEqual(decoded, frameFor(f), "decode mismatch for \(f.name)")
        }
    }

    func testRoundTrips() throws {
        let fx = try loadFixtures()
        for f in fx.frames {
            let frame = frameFor(f)
            XCTAssertEqual(decodeFrame(try encodeFrame(frame)), frame, "round-trip for \(f.name)")
        }
    }

    func testMalformedIsIgnoredNeverThrows() throws {
        let fx = try loadFixtures()
        for m in fx.malformed {
            XCTAssertNil(decodeFrame(unhex(m.hex)), "expected nil for \(m.name)")
        }
    }

    func testPreservesSeqBeyond53Bits() throws {
        let big: UInt64 = (1 << 63) + 12345
        let f: Frame = .data(seq: big, ack: 0, payload: [], durable: false, coalesceKey: nil)
        let rt = decodeFrame(try encodeFrame(f))
        XCTAssertEqual(rt, f)
    }

    func testStrLengthIsUTF8Bytes() throws {
        let f: Frame = .hello(epoch: "🐙", recvEpoch: "", recvCursor: 0, durableSupported: false, maxRetentionMs: 0)
        let rt = decodeFrame(try encodeFrame(f))
        XCTAssertEqual(rt, f)
    }

    func testRejectsEpochLongerThan255Bytes() {
        let f: Frame = .hello(epoch: String(repeating: "x", count: 256), recvEpoch: "", recvCursor: 0, durableSupported: false, maxRetentionMs: 0)
        XCTAssertThrowsError(try encodeFrame(f))
    }
}

// MARK: - hex helpers

func hex(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

func unhex(_ s: String) -> [UInt8] {
    if s.isEmpty { return [] }
    var out: [UInt8] = []
    var idx = s.startIndex
    while idx < s.endIndex {
        let next = s.index(idx, offsetBy: 2)
        out.append(UInt8(s[idx..<next], radix: 16)!)
        idx = next
    }
    return out
}
