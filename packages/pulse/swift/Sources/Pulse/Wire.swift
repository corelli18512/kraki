import Foundation

/// Wire codec — binary frame encode/decode. See `spec/PROTOCOL.md` §5.0 and
/// `spec/FIXTURES.md`. Byte-for-byte identical to the TypeScript port.
///
/// Layout (big-endian):
///   header : u8 magic=0xB1 · u8 version=0x01 · u8 type
///   str    : u8 len · len UTF-8 bytes
///   blob   : u32 len · len bytes
///   u64    : 8 bytes big-endian

public let pulseMagic: UInt8 = 0xB1
public let pulseVersion: UInt8 = 0x01

public enum FrameType: UInt8 {
    case hello = 1
    case data = 2
    case ack = 3
    case reset = 4
    case heartbeat = 5
}

/// A decoded protocol frame.
public enum Frame: Equatable {
    case hello(epoch: String, recvEpoch: String, recvCursor: UInt64, durableSupported: Bool, maxRetentionMs: UInt64)
    case data(seq: UInt64, ack: UInt64, payload: [UInt8], durable: Bool)
    case ack(ack: UInt64)
    case reset(epoch: String, oldest: UInt64)
    case heartbeat(ack: UInt64)
}

public enum WireError: Error {
    case stringTooLong(Int)
}

// MARK: - Encoder

private struct Writer {
    var bytes: [UInt8] = []
    mutating func u8(_ n: UInt8) { bytes.append(n) }
    mutating func u32(_ n: UInt32) {
        bytes.append(UInt8((n >> 24) & 0xFF))
        bytes.append(UInt8((n >> 16) & 0xFF))
        bytes.append(UInt8((n >> 8) & 0xFF))
        bytes.append(UInt8(n & 0xFF))
    }
    mutating func u64(_ n: UInt64) {
        var shift: UInt64 = 56
        while true {
            bytes.append(UInt8((n >> shift) & 0xFF))
            if shift == 0 { break }
            shift -= 8
        }
    }
    mutating func str(_ s: String) throws {
        let b = Array(s.utf8)
        if b.count > 255 { throw WireError.stringTooLong(b.count) }
        u8(UInt8(b.count))
        bytes.append(contentsOf: b)
    }
    mutating func blob(_ b: [UInt8]) {
        u32(UInt32(b.count))
        bytes.append(contentsOf: b)
    }
    mutating func header(_ t: FrameType) {
        u8(pulseMagic)
        u8(pulseVersion)
        u8(t.rawValue)
    }
}

/// Encode a frame to its wire bytes.
public func encodeFrame(_ f: Frame) throws -> [UInt8] {
    var w = Writer()
    switch f {
    case let .hello(epoch, recvEpoch, recvCursor, durableSupported, maxRetentionMs):
        w.header(.hello)
        try w.str(epoch)
        try w.str(recvEpoch)
        w.u64(recvCursor)
        w.u8(durableSupported ? 1 : 0)
        w.u64(maxRetentionMs)
    case let .data(seq, ack, payload, durable):
        w.header(.data)
        w.u8(durable ? 1 : 0)
        w.u64(seq)
        w.u64(ack)
        w.blob(payload)
    case let .ack(ack):
        w.header(.ack)
        w.u64(ack)
    case let .reset(epoch, oldest):
        w.header(.reset)
        try w.str(epoch)
        w.u64(oldest)
    case let .heartbeat(ack):
        w.header(.heartbeat)
        w.u64(ack)
    }
    return w.bytes
}

// MARK: - Decoder

private struct Reader {
    let b: [UInt8]
    var off = 0
    init(_ bytes: [UInt8]) { b = bytes }

    mutating func need(_ n: Int) throws {
        if off + n > b.count { throw DecodeShort.short }
    }
    mutating func u8() throws -> UInt8 {
        try need(1)
        defer { off += 1 }
        return b[off]
    }
    mutating func u32() throws -> UInt32 {
        try need(4)
        defer { off += 4 }
        return (UInt32(b[off]) << 24) | (UInt32(b[off + 1]) << 16)
            | (UInt32(b[off + 2]) << 8) | UInt32(b[off + 3])
    }
    mutating func u64() throws -> UInt64 {
        try need(8)
        var v: UInt64 = 0
        for i in 0..<8 { v = (v << 8) | UInt64(b[off + i]) }
        off += 8
        return v
    }
    mutating func str() throws -> String {
        let len = Int(try u8())
        try need(len)
        let slice = Array(b[off..<off + len])
        off += len
        return String(decoding: slice, as: UTF8.self)
    }
    mutating func blob() throws -> [UInt8] {
        let len = Int(try u32())
        try need(len)
        let slice = Array(b[off..<off + len])
        off += len
        return slice
    }
}

private enum DecodeShort: Error { case short }

/// Decode wire bytes to a frame, or `nil` if malformed / unknown / truncated.
/// MUST NOT throw on bad input (spec §5.0 robustness).
public func decodeFrame(_ bytes: [UInt8]) -> Frame? {
    var r = Reader(bytes)
    do {
        if try r.u8() != pulseMagic { return nil }
        if try r.u8() != pulseVersion { return nil }
        let rawType = try r.u8()
        guard let type = FrameType(rawValue: rawType) else { return nil }
        switch type {
        case .hello:
            let epoch = try r.str()
            let recvEpoch = try r.str()
            let recvCursor = try r.u64()
            let durFlags = try r.u8()
            let maxRetentionMs = try r.u64()
            return .hello(
                epoch: epoch, recvEpoch: recvEpoch, recvCursor: recvCursor,
                durableSupported: (durFlags & 1) == 1, maxRetentionMs: maxRetentionMs)
        case .data:
            let msgFlags = try r.u8()
            let seq = try r.u64()
            let ack = try r.u64()
            let payload = try r.blob()
            return .data(seq: seq, ack: ack, payload: payload, durable: (msgFlags & 1) == 1)
        case .ack:
            return .ack(ack: try r.u64())
        case .reset:
            let epoch = try r.str()
            let oldest = try r.u64()
            return .reset(epoch: epoch, oldest: oldest)
        case .heartbeat:
            return .heartbeat(ack: try r.u64())
        }
    } catch {
        return nil
    }
}
