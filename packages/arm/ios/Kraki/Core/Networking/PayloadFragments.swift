import Foundation

/// Large Pulse payloads as ordered fragments (mirrors
/// `packages/protocol/src/fragments.ts`). Native WebSockets expose no partial
/// frame progress, so one multi-hundred-KB message on a slow link looks like a
/// dead connection; small parts keep showing progress. Used only with a
/// Tentacle that advertised `fragments` (and after this app declared it).
enum PayloadFragments {
    static let feature = "fragments"
    static let threshold = 64 * 1024
    static let size = 32 * 1024

    /// Fragment payloads for `payload`, or nil when it should go whole
    /// (small, or not ASCII — encrypted `{blob, keys}` payloads always are).
    static func split(_ payload: Data, id: String = UUID().uuidString,
                      size: Int = size, threshold: Int = threshold) -> [Data]? {
        guard payload.count > threshold, !payload.contains(where: { $0 >= 0x80 }),
              let text = String(data: payload, encoding: .ascii) else { return nil }
        let chars = Array(text.utf8)
        let n = (chars.count + size - 1) / size
        var parts: [Data] = []
        parts.reserveCapacity(n)
        for i in 0..<n {
            let slice = chars[(i * size)..<min(chars.count, (i + 1) * size)]
            let part: [String: Any] = ["kfrag": 1, "id": id, "i": i, "n": n,
                                       "d": String(decoding: slice, as: UTF8.self)]
            guard let data = try? JSONSerialization.data(withJSONObject: part) else { return nil }
            parts.append(data)
        }
        return parts
    }
}

/// Reassembles fragments; memory bounded (oldest incomplete dropped beyond
/// `maxBytes`, untouched ones after `ttl`). A dropped payload never surfaces;
/// higher layers (re-requests, confirmations) recover it.
final class PayloadAssembler {
    private struct Pending { var parts: [String?]; var got = 0; var bytes = 0; var touched: Date }
    private var sets: [String: Pending] = [:]
    private var order: [String] = []
    private var bytes = 0
    private var lastSweep = Date.distantPast
    private let maxBytes: Int, maxParts: Int, ttl: TimeInterval
    private let now: () -> Date

    init(maxBytes: Int = 48 * 1024 * 1024, maxParts: Int = 4096, ttl: TimeInterval = 600,
         now: @escaping () -> Date = Date.init) {
        self.maxBytes = maxBytes; self.maxParts = maxParts; self.ttl = ttl; self.now = now
    }

    var pendingPayloads: Int { sets.count }

    /// Cheap pre-check: a part is at most `PayloadFragments.size` characters
    /// plus JSON escaping and a small envelope, and mentions `kfrag`. Larger
    /// payloads are never parsed here (key order is not guaranteed, so no
    /// prefix test).
    static func mayBeFragment(_ payload: [UInt8]) -> Bool {
        guard payload.count <= PayloadFragments.size * 2 + 1024 else { return false }
        let marker: [UInt8] = Array(#""kfrag""#.utf8)
        guard payload.count >= marker.count else { return false }
        for start in 0...(payload.count - marker.count) where payload[start] == marker[0] {
            if Array(payload[start..<(start + marker.count)]) == marker { return true }
        }
        return false
    }

    /// Returns the whole payload when this fragment completes it; nil while
    /// incomplete. `isFragment` is false when the payload is not a fragment.
    func accept(_ payload: [UInt8]) -> (isFragment: Bool, whole: String?) {
        guard Self.mayBeFragment(payload),
              let object = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any],
              object["kfrag"] as? Int == 1,
              let id = object["id"] as? String,
              let i = object["i"] as? Int, let n = object["n"] as? Int,
              let d = object["d"] as? String,
              n > 0, i >= 0, i < n else { return (false, nil) }
        guard n <= maxParts else { return (true, nil) }
        let t = now()
        // Expiry is a sweep over every set; run it at most every 30 s rather
        // than on each fragment of a large payload.
        if t.timeIntervalSince(lastSweep) > 30 {
            lastSweep = t
            for (key, set) in sets where t.timeIntervalSince(set.touched) > ttl { drop(key) }
        }
        // A set that changed its part count was restarted by the sender: start
        // over instead of ignoring the new parts until the old set expires.
        if let existing = sets[id], existing.parts.count != n { drop(id) }
        var set = sets[id] ?? { order.append(id); return Pending(parts: Array(repeating: nil, count: n), touched: t) }()
        set.touched = t
        if set.parts[i] == nil {
            set.parts[i] = d
            set.got += 1
            set.bytes += d.utf8.count
            bytes += d.utf8.count
        }
        sets[id] = set
        if set.got == n {
            drop(id)
            return (true, set.parts.map { $0 ?? "" }.joined())
        }
        var index = 0
        while bytes > maxBytes, index < order.count {
            if order[index] == id { index += 1 } else { drop(order[index]) }
        }
        return (true, nil)
    }

    func clear() { sets.removeAll(); order.removeAll(); bytes = 0 }

    private func drop(_ id: String) {
        guard let set = sets.removeValue(forKey: id) else { return }
        bytes -= set.bytes
        order.removeAll { $0 == id }
    }
}
