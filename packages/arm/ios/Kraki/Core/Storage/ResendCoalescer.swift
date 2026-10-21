import Foundation

/// Whether an automatic re-send would only repeat a copy of an input that the
/// current connection carried moments ago. Diag 10-18 10:32: back from the
/// background, one input went out on `reconnected` and again 77 ms later on
/// `greeting`; the Tentacle saw two copies and echoed twice.
///
/// Only triggers that say "this connection is new / was greeted" coalesce. A
/// Tentacle that itself reconnected (`tentacle_online`) or a changed route
/// (local link, device trust, session created) may have lost the earlier
/// copy, so those always re-send. If a coalesced copy was lost after all, the
/// confirmation timer still re-sends it once the input stalls.
struct ResendCoalescer {
    static let window: TimeInterval = 5
    static let coalescedReasons: Set<String> = ["reconnected", "greeting"]

    var now: () -> Date = Date.init
    /// clientId → when the current connection last carried it.
    private var handedOffAt: [String: Date] = [:]

    mutating func handedOff(_ clientId: String) { handedOffAt[clientId] = now() }

    mutating func forget(_ clientId: String) { handedOffAt.removeValue(forKey: clientId) }

    /// The connection closed: nothing it carried counts any more.
    mutating func transportClosed() { handedOffAt.removeAll() }

    func isRedundant(_ clientId: String, reason: String) -> Bool {
        guard Self.coalescedReasons.contains(reason), let at = handedOffAt[clientId] else { return false }
        return now().timeIntervalSince(at) < Self.window
    }
}
