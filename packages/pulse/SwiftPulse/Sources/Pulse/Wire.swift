import Foundation

/// Wire codec — binary frame encode/decode. See `spec/PROTOCOL.md` §5.0 and
/// `spec/FIXTURES.md`. Byte-for-byte identical to the TypeScript port.
///
/// Layout (big-endian):
///   header v1: u8 magic=0xB1 · u8 version=0x01 · u8 type
///   header v2: u8 magic=0xB1 · u8 version=0x02 · u8 type · u8 streamId
///   str    : u8 len · len UTF-8 bytes
///   blob   : u32 len · len bytes
///   u64    : 8 bytes big-endian
///
/// v2 adds a 1-byte `streamId` (spec §13, multi-stream). It is used whenever
/// `streamId > 0`; `streamId == 0` is encoded as v1 so a single-stream peer is
/// byte-identical to the pre-§13 format. Decoders accept BOTH versions.

public let pulseMagic: UInt8 = 0xB1
/// Current wire version (encodes the streamId header).
public let pulseVersion: UInt8 = 0x02
/// Legacy wire version accepted on decode (streamId implicit 0).
public let pulseV1Version: UInt8 = 0x01

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
    case data(seq: UInt64, ack: UInt64, payload: [UInt8], durable: Bool, coalesceKey: String?)
    case ack(ack: UInt64)
    case reset(epoch: String, oldest: UInt64)
    case heartbeat(ack: UInt64)
}

/// A decoded frame together with the stream it belongs to. `streamId` is a
/// transport-routing concern, not a property of the frame itself.
public struct DecodedFrame: Equatable {
    public let frame: Frame
    public let streamId: UInt8
    public init(frame: Frame, streamId: UInt8) {
        self.frame = frame
        self.streamId = streamId
    }
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
    /// Write the header. v2 (with streamId) for any non-default stream;
    /// streamId=0 is encoded as v1 so single-stream peers stay byte-identical.
    mutating func header(_ t: FrameType, streamId: UInt8) {
        u8(pulseMagic)
        if streamId > 0 {
            u8(pulseVersion)
            u8(t.rawValue)
            u8(streamId)
        } else {
            u8(pulseV1Version)
            u8(t.rawValue)
        }
    }
}

/// Encode a frame to its wire bytes. `streamId` defaults to 0 (the legacy
/// single stream) so callers that never use multi-stream are unchanged.
public func encodeFrame(_ f: Frame, streamId: UInt8 = 0) throws -> [UInt8] {
    var w = Writer()
    switch f {
    case let .hello(epoch, recvEpoch, recvCursor, durableSupported, maxRetentionMs):
        w.header(.hello, streamId: streamId)
        try w.str(epoch)
        try w.str(recvEpoch)
        w.u64(recvCursor)
        w.u8(durableSupported ? 1 : 0)
        w.u64(maxRetentionMs)
    case let .data(seq, ack, payload, durable, coalesceKey):
        w.header(.data, streamId: streamId)
        w.u8((durable ? 1 : 0) | (coalesceKey != nil ? 2 : 0))
        w.u64(seq)
        w.u64(ack)
        w.blob(payload)
        if let key = coalesceKey { try w.str(key) }
    case let .ack(ack):
        w.header(.ack, streamId: streamId)
        w.u64(ack)
    case let .reset(epoch, oldest):
        w.header(.reset, streamId: streamId)
        try w.str(epoch)
        w.u64(oldest)
    case let .heartbeat(ack):
        w.header(.heartbeat, streamId: streamId)
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

private func readBody(_ r: inout Reader, _ type: FrameType) throws -> Frame {
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
        let hasKey = (msgFlags & 2) == 2
        let coalesceKey: String? = hasKey ? try r.str() : nil
        return .data(seq: seq, ack: ack, payload: payload, durable: (msgFlags & 1) == 1, coalesceKey: coalesceKey)
    case .ack:
        return .ack(ack: try r.u64())
    case .reset:
        let epoch = try r.str()
        let oldest = try r.u64()
        return .reset(epoch: epoch, oldest: oldest)
    case .heartbeat:
        return .heartbeat(ack: try r.u64())
    }
}

/// Decode wire bytes to a frame + its stream id, or `nil` if malformed /
/// unknown / truncated. Accepts both v1 (streamId 0) and v2 (streamId header).
public func decodeFrameWithStream(_ bytes: [UInt8]) -> DecodedFrame? {
    var r = Reader(bytes)
    do {
        if try r.u8() != pulseMagic { return nil }
        let version = try r.u8()
        if version == pulseVersion {
            // v2: type followed by a 1-byte streamId.
            let rawType = try r.u8()
            guard let type = FrameType(rawValue: rawType) else { return nil }
            let streamId = try r.u8()
            let frame = try readBody(&r, type)
            return DecodedFrame(frame: frame, streamId: streamId)
        }
        if version == pulseV1Version {
            // v1: no streamId; belongs to the default stream 0.
            let rawType = try r.u8()
            guard let type = FrameType(rawValue: rawType) else { return nil }
            let frame = try readBody(&r, type)
            return DecodedFrame(frame: frame, streamId: 0)
        }
        return nil // unknown version
    } catch {
        return nil
    }
}

/// Decode wire bytes to a frame, dropping the stream id. Convenience for
/// single-stream endpoints that only own stream 0.
public func decodeFrame(_ bytes: [UInt8]) -> Frame? {
    decodeFrameWithStream(bytes)?.frame
}
