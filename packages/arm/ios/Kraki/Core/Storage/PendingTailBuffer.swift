/// PendingTailBuffer — pure data structure backing
/// MessageProvider's push-gap recovery.
///
/// **Problem.** Pushes from tentacle land with strictly ascending
/// `seq`. Network reorder, brief WebSocket flap, or app-suspend
/// races can cause us to receive `seq=205` while we last persisted
/// `seq=200` (gap [201..204]). Today MessageStore silently drops
/// such pushes from the in-memory window — they hit DB but the UI
/// never sees them, and the next push (`seq=206`) just widens the
/// hole. There is no recovery without a manual fetch.
///
/// **Buffer model.** MessageProvider funnels every persistent push
/// through this struct instead of straight to the store. We keep a
/// sorted-by-seq, dedup-by-seq buffer; only the contiguous prefix
/// starting at `dbLast + 1` is ever committed back to the store.
/// When a gap exists between `dbLast + 1` and the lowest buffered
/// seq, the wrapper fires a `request_session_messages_range`
/// against tentacle and inserts the response into the buffer. The
/// drain loop runs again, advancing as far as it can, and repeats
/// until the buffer is empty.
///
/// **Tombstones.** Tentacle filters non-persistent types out of the
/// range response, so seqs that were live on the wire (e.g. an
/// `active` heartbeat at seq=203 inside our [201..204] request)
/// won't come back. The drain loop must still advance past them or
/// it would stall forever. `tombstones` records seqs the server has
/// explicitly told us are missing; drain treats them as virtual
/// committed entries.
///
/// **Why a separate pure struct?** The algorithm has enough corner
/// cases (truncation, dedupe, multi-hole convergence, tombstone GC)
/// that it deserves stand-alone unit tests. The wrapper
/// (`MessageProvider`) owns the network I/O, timeouts, and main-queue
/// hops — orthogonal concerns.
struct PendingTailBuffer {
    /// Maximum number of buffered messages per session before we
    /// start dropping the oldest. If we ever hit this we've almost
    /// certainly stopped getting `range_batch` responses from
    /// tentacle — emit a warning and keep the most recent end.
    static let cap = 5000

    /// Sorted ascending by `seq`. Unique on `seq` (dedupe on insert).
    private(set) var messages: [ChatMessage] = []

    /// Seqs that tentacle has confirmed are not persistent (filtered
    /// from a `range_batch` response). Drain steps past these as if
    /// they were committed. GC'd to `seq >= cursor` after each drain.
    private(set) var tombstones: Set<Int> = []

    var isEmpty: Bool { messages.isEmpty && tombstones.isEmpty }

    /// Lowest buffered seq, or nil if empty.
    var minSeq: Int? { messages.first?.seq }

    /// Insert a single message. Binary-search insertion keeps the
    /// buffer sorted; duplicates (same seq) are ignored — the first
    /// insertion wins, consistent with the store's invariant that
    /// content for a given seq never changes.
    ///
    /// Returns `true` if the insert pushed past the cap and an
    /// older entry was dropped.
    @discardableResult
    mutating func insert(_ msg: ChatMessage) -> Bool {
        // Binary search for insertion index.
        var lo = 0, hi = messages.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if messages[mid].seq < msg.seq { lo = mid + 1 } else { hi = mid }
        }
        // Dedupe: same seq already in buffer.
        if lo < messages.count && messages[lo].seq == msg.seq { return false }
        messages.insert(msg, at: lo)
        if messages.count > Self.cap {
            let excess = messages.count - Self.cap
            messages.removeFirst(excess)
            return true
        }
        return false
    }

    /// Insert a batch of messages. Returns true if cap was hit on
    /// any insert.
    @discardableResult
    mutating func insertAll(_ msgs: [ChatMessage]) -> Bool {
        var didOverflow = false
        for m in msgs { if insert(m) { didOverflow = true } }
        return didOverflow
    }

    /// Outcome of a single drain pass.
    struct DrainAction: Equatable {
        /// Contiguous prefix to commit to the store (already removed
        /// from the buffer). Empty if no progress was made.
        var toCommit: [ChatMessage]
        /// Next range fetch the caller should issue, if any.
        /// `nil` means either buffer is empty or another request is
        /// already in flight.
        var nextFetch: ClosedRange<Int>?
    }

    /// Compute the next drain action.
    ///
    /// Steps:
    ///   0. Drop buffered entries with `seq <= dbLast` (already
    ///      committed via another path, e.g. a turn-aligned
    ///      `request_session_messages` batch that landed first).
    ///   1. Walk forward from `cursor = dbLast + 1`. At each cursor
    ///      value: if `buffer.first.seq == cursor`, pop it into the
    ///      commit list and advance. If `cursor` is in `tombstones`,
    ///      just advance. Otherwise stop — we have a real gap.
    ///   2. GC tombstones that are now strictly below `cursor`.
    ///   3. If buffer is non-empty and no request is already in
    ///      flight, propose the next fetch `[cursor ... head - 1]`.
    ///
    /// - Parameters:
    ///   - dbLast: highest seq currently in the store's DB.
    ///   - hasInflight: true if an outstanding range request is
    ///     already in flight for this session.
    mutating func drain(dbLast: Int, hasInflight: Bool) -> DrainAction {
        // 0. Drop stale (already-committed) entries.
        while let first = messages.first, first.seq <= dbLast {
            messages.removeFirst()
        }
        // Drop tombstones at or below dbLast — they're handled.
        tombstones = tombstones.filter { $0 > dbLast }

        // 1. Walk the contiguous prefix.
        var cursor = dbLast + 1
        var toCommit: [ChatMessage] = []
        while true {
            if let first = messages.first, first.seq == cursor {
                toCommit.append(first)
                messages.removeFirst()
                cursor += 1
            } else if tombstones.contains(cursor) {
                cursor += 1
            } else {
                break
            }
        }

        // 2. GC tombstones below cursor.
        tombstones = tombstones.filter { $0 >= cursor }

        // 3. Next fetch — only if there's still a buffered head AND
        //    no request is already in flight.
        var next: ClosedRange<Int>? = nil
        if !hasInflight, let head = messages.first, head.seq > cursor {
            next = cursor ... (head.seq - 1)
        }

        return DrainAction(toCommit: toCommit, nextFetch: next)
    }

    /// Record what a `session_messages_range_batch` response told us
    /// about a requested range. Inserts the returned messages into
    /// the buffer and tombstones seqs the server confirmed are not
    /// persistent.
    ///
    /// Tombstone rules:
    ///   - Inside `[responseFirstSeq ... responseLastSeq]`: any seq
    ///     not present in the response is non-persistent → tombstone.
    ///   - `[responseLastSeq + 1 ... requestedTo]`: server returns
    ///     newest-end first; a short high end means tentacle confirmed
    ///     nothing past `responseLastSeq` exists in that range
    ///     → tombstone unconditionally.
    ///   - `[requestedFrom ... responseFirstSeq - 1]`: tombstone ONLY
    ///     if `truncated == false`. Truncated responses chop the LOW
    ///     end (server's 500-row cap) — those seqs may still arrive in
    ///     a follow-up request, so do not tombstone them.
    ///   - Empty response (`responseFirstSeq == 0`) with
    ///     `truncated == false`: the entire requested range is empty
    ///     → tombstone all of `[requestedFrom ... requestedTo]`.
    ///   - Empty response with `truncated == true`: per protocol spec
    ///     this should not happen; ignore (no state change).
    ///
    /// Returns true if buffer overflow occurred.
    @discardableResult
    mutating func ingestRangeResponse(
        messages newMessages: [ChatMessage],
        requestedFrom: Int,
        requestedTo: Int,
        responseFirstSeq: Int,
        responseLastSeq: Int,
        truncated: Bool
    ) -> Bool {
        guard requestedFrom <= requestedTo else { return false }

        let returnedSeqs = Set(newMessages.map(\.seq))

        if responseFirstSeq > 0 && responseLastSeq >= responseFirstSeq {
            // Tombstone gaps inside the response window.
            for s in responseFirstSeq...responseLastSeq where !returnedSeqs.contains(s) {
                tombstones.insert(s)
            }
            // High edge: short → tombstone.
            if responseLastSeq < requestedTo {
                for s in (responseLastSeq + 1)...requestedTo {
                    tombstones.insert(s)
                }
            }
            // Low edge: only if not truncated.
            if !truncated && responseFirstSeq > requestedFrom {
                for s in requestedFrom..<responseFirstSeq {
                    tombstones.insert(s)
                }
            }
        } else if !truncated {
            // Empty, conclusive response.
            for s in requestedFrom...requestedTo {
                tombstones.insert(s)
            }
        }
        // Truncated with empty data is undefined per spec — do nothing.

        return insertAll(newMessages)
    }

    /// Reset all state. Used on tentacle reconnect when the
    /// in-flight tracking is also cleared.
    mutating func reset() {
        messages.removeAll()
        tombstones.removeAll()
    }
}
