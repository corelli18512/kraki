import Foundation

/// Which turn-trace requests ("Steps") to actually send. Keys are
/// `sessionId:bubbleSeq`.
///
/// A still-running turn's trace stays re-pullable, but a request already on
/// its way is not sent again for the same intent: opening live Steps asked
/// twice within ~40 ms (the tap, then the sheet's `onAppear`), and every copy
/// re-shipped the whole trace (tentacle log 10-12→10-21: 47 duplicate replies,
/// 4 014 entries, e.g. 1 034 entries twice). A later request while one is in
/// flight is answered by pulling once more after the reply, so a step added
/// meanwhile is not missed.
struct TurnTraceRequestLedger {
    /// Requests this close to the one in flight carry no newer intent.
    static let duplicateWindow: TimeInterval = 1
    /// No reply by then: assume it was lost and allow a new request.
    static let inFlightTimeout: TimeInterval = 10
    /// A completed trace is re-requested only after this long (and only if
    /// it is not cached).
    static let pulledFreshness: TimeInterval = 10

    var now: () -> Date = Date.init
    private var pulled: [String: Date] = [:]
    private var inFlight: [String: Date] = [:]
    private var repullAfterReply = Set<String>()

    /// Whether to send a request now (and record it as sent).
    /// `repullIfInFlight`: the caller knows the turn changed (it ended), so a
    /// request in flight, however recent, is followed by one more pull.
    mutating func shouldRequest(_ key: String, cached: Bool, repullIfInFlight: Bool = false) -> Bool {
        let t = now()
        if let sent = inFlight[key], t.timeIntervalSince(sent) < Self.inFlightTimeout {
            if repullIfInFlight || t.timeIntervalSince(sent) >= Self.duplicateWindow { repullAfterReply.insert(key) }
            return false
        }
        if let at = pulled[key] {
            guard !cached, t.timeIntervalSince(at) > Self.pulledFreshness else { return false }
        }
        // Only a recent request dedupes; forget old ones so a long-lived
        // process doesn't keep one entry per turn ever opened.
        if pulled.count > 500 {
            let cutoff = t.addingTimeInterval(-60)
            pulled = pulled.filter { $0.value > cutoff }
            inFlight = inFlight.filter { $0.value > cutoff }
        }
        pulled[key] = t
        inFlight[key] = t
        return true
    }

    /// Force a re-pull on the next request (a live turn moved on).
    mutating func invalidate(_ key: String) { pulled.removeValue(forKey: key) }

    /// A reply landed. A still-running turn (`complete == false`) stays
    /// re-pullable. Returns whether to pull again now (asked meanwhile).
    mutating func replied(_ key: String, complete: Bool) -> Bool {
        inFlight.removeValue(forKey: key)
        let repull = repullAfterReply.remove(key) != nil
        if complete {
            if pulled[key] == nil { pulled[key] = now() }
        } else {
            pulled.removeValue(forKey: key)
        }
        return repull && !complete
    }

    /// The session was wiped and reloads from scratch.
    mutating func forgetSession(_ sessionId: String) {
        let prefix = "\(sessionId):"
        pulled = pulled.filter { !$0.key.hasPrefix(prefix) }
        inFlight = inFlight.filter { !$0.key.hasPrefix(prefix) }
        repullAfterReply = repullAfterReply.filter { !$0.hasPrefix(prefix) }
    }

    mutating func clear() {
        pulled.removeAll()
        inFlight.removeAll()
        repullAfterReply.removeAll()
    }
}
