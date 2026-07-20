import Foundation

/// Multi-stream multiplexer for one shared link. See `spec/PROTOCOL.md` §13.
///
/// A single WebSocket carries N independent Pulse streams, each a full
/// `Endpoint` with its own epoch / seq / outbox / cursor / handshake. The wire
/// header's `streamId` (v2) routes each frame to the endpoint that owns it.
///
/// Why this exists: a single ordered stream head-of-line blocks any low-latency
/// message behind a bulk transfer sharing it. Splitting bulk (history replay,
/// turn-trace batches, attachment chunks) onto its own stream means a live
/// message (echo, abort, status card) gets its own seq space and is never
/// queued behind bulk seqs.
///
/// Scheduling: `onTick` visits streams in ascending `streamId` order so a
/// lower-numbered (live) stream's transmit effects are emitted before a
/// higher-numbered (bulk) stream's. Liveness is per-stream: each endpoint
/// tracks its own `lastRecvAt` and emits its own heartbeats. The physical link
/// is shared, so connect/disconnect events are broadcast to every stream.
public final class StreamSet {
    private var streams: [UInt8: Endpoint] = [:]
    /// Ascending streamIds so `onTick` emits live (low-id) transmits first.
    private var order: [UInt8] = []

    public init(_ streams: [Endpoint] = []) {
        for ep in streams { _ = register(ep) }
    }

    /// Add a stream. The endpoint's `stream` id must be unique within the set.
    @discardableResult
    public func register(_ ep: Endpoint) -> StreamSet {
        let id = ep.stream
        if streams[id] != nil {
            fatalError("stream \(id) already registered")
        }
        streams[id] = ep
        order = streams.keys.sorted()
        return self
    }

    /// The endpoint owning `streamId`, or nil if no such stream is registered.
    public func get(_ streamId: UInt8) -> Endpoint? { streams[streamId] }

    /// Send on a specific stream. Fatal error if the stream isn't registered.
    @discardableResult
    public func send(
        _ streamId: UInt8,
        _ payload: [UInt8],
        durable: Bool = false,
        coalesceKey: String? = nil
    ) -> (seq: UInt64, effects: [Effect]) {
        guard let ep = streams[streamId] else {
            fatalError("unknown stream \(streamId)")
        }
        return ep.send(payload, durable: durable, coalesceKey: coalesceKey)
    }

    /// The link came up: every stream resumes (sends its HELLO), in ascending
    /// stream order.
    public func onConnected(_ now: Int) -> [Effect] {
        var out: [Effect] = []
        for id in order { out.append(contentsOf: streams[id]!.onConnected(now)) }
        return out
    }

    /// The link went down: every stream marks itself disconnected (retains its
    /// outbox for resume).
    public func onDisconnected(_ now: Int) -> [Effect] {
        var out: [Effect] = []
        for id in order { out.append(contentsOf: streams[id]!.onDisconnected(now)) }
        return out
    }

    /// A frame arrived on the shared link. Decode once, route to the owning
    /// stream. Frames for an unknown / unregistered streamId are dropped.
    public func onBytes(_ bytes: [UInt8], _ now: Int) -> [Effect] {
        guard let d = decodeFrameWithStream(bytes) else { return [] }
        guard let ep = streams[d.streamId] else { return [] }
        return ep.onFrame(d.frame, now)
    }

    /// Periodic tick for every stream, in ascending stream order so a live
    /// (low-id) stream's transmit effects precede a bulk (high-id) stream's.
    public func onTick(_ now: Int) -> [Effect] {
        var out: [Effect] = []
        for id in order { out.append(contentsOf: streams[id]!.onTick(now)) }
        return out
    }
}
