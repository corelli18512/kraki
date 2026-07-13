/// MessageStore — Per-session message window plus the disk-backed
/// truth in `MessageDatabase`.
///
/// **Design model.** Each session has a contiguous in-memory window
/// (`messages[sessionId]`) that is a *subset* of what's actually
/// persisted in SQLite. The window's range is tracked in
/// `windows[sessionId]`. Callers that need the full truth (e.g.
/// `MessageProvider` deciding "do I need to fetch from tentacle?")
/// go through the DB-only query methods below; callers that render
/// (e.g. ChatViewModel) read the window.
///
/// **Writes always hit DB first.** Live messages from the relay and
/// batch replays from tentacle both go through `append` /
/// `ingestBatch`, which persist to DB and *then* decide whether the
/// new content extends the active window. Messages that arrive while
/// no session is open don't materialise into memory at all.
///
/// **Replacements for the JSONL era.** This file replaces the old
/// `PersistentMessageCache` (which lazy-hydrated entire per-session
/// JSONL files into memory and never let go). It also drops the old
/// `pendingPermissions` / `pendingQuestions` dictionaries —
/// pending state is now derived from messages at the call site,
/// because the tentacle invariant "agent is paused while perm is
/// unresolved" means `preview.type == "permission"` already encodes
/// it for sidebar use, and ChatView can scan its loaded window for
/// the rest.

import Foundation
import Observation

@Observable
final class MessageStore {

    // MARK: - Persistent backbone

    let db: MessageDatabase

    init(db: MessageDatabase) {
        self.db = db
    }

    // MARK: - Per-session window

    /// Window of messages currently held in memory, per session.
    /// Always a contiguous `[topSeq..bottomSeq]` slice of the DB,
    /// or empty if the session has never been opened in this
    /// process. Mutations are always single dict re-assignments so
    /// `@Observable` fires exactly once per logical update.
    var messages: [String: [ChatMessage]] = [:]

    /// Metadata about each session's loaded window. Absent ⇒ no
    /// window loaded ⇒ messages[sessionId] is also empty.
    var windows: [String: WindowState] = [:]

    struct WindowState: Equatable {
        /// Lowest seq in `messages[sessionId]`.
        var topSeq: Int
        /// Highest seq in `messages[sessionId]`.
        var bottomSeq: Int
        /// True when we've reached the start of recorded history
        /// (a `loadOlder` returned nothing more). Drives the top
        /// spinner's "fully loaded" state.
        var reachedTail: Bool
        /// True when `bottomSeq` equals the session's real `lastSeq`
        /// per the latest tentacle info. Drives the bottom spinner.
        var reachedHead: Bool
    }

    // MARK: - Persistence policy

    /// Message types that get written to disk. Mirrors tentacle's
    /// `PERSISTENT_TYPES` — anything outside this set is transient
    /// (deltas, attachment_data, active, mode/title/pin updates,
    /// etc.) and lives only in memory. Optimistic pending input
    /// placeholders never reach this store — they live in
    /// `CommandSender.outbox` and are appended at render time.
    static let persistentTypes: Set<String> = [
        "session_created",
        "agent_message",
        "interrupted_turn",
        "turn_status",
        "user_message",
        "permission",
        "permission_resolved",
        "question",
        "question_resolved",
        "tool_start",
        "tool_complete",
        "error",
        "session_ended",
        "idle",
        "answer",
        "approve",
        "deny",
        "always_allow",
    ]

    static func isPersistent(_ msg: ChatMessage) -> Bool {
        msg.seq > 0 && persistentTypes.contains(msg.type)
    }

    private static let initialWindowSize = 100
    private static let pageSize = 100

    // MARK: - Live write

    /// Append a single live message. Always persists (if persistent
    /// type); only materialises into the in-memory window when the
    /// session has an active window AND the message extends it
    /// contiguously at the tail.
    ///
    /// Active-window decision:
    ///   - msg.seq == bottomSeq + 1 → append into window; bump
    ///     bottomSeq; mark reachedHead true if we now equal the
    ///     known session lastSeq (caller updates lastSeq separately).
    ///   - msg.seq > bottomSeq + 1  → gap, leave the window alone
    ///     so it stays contiguous; ChatViewModel.loadNewer() will
    ///     pull the missing slice on demand.
    ///   - msg.seq <= bottomSeq     → dedup / late re-broadcast;
    ///     replace the matching (seq, type) in the window if it's
    ///     in range.
    func append(_ sessionId: String, _ message: ChatMessage) {
        if Self.isPersistent(message) {
            try? db.insert(sessionId, [message])
        }

        guard let state = windows[sessionId] else { return }

        // Empty bootstrap state (session opened against empty DB,
        // window placeholder set with topSeq=bottomSeq=0). Any new
        // message means we now have content — rebuild the window
        // from DB so this message and any siblings persisted ahead of
        // it materialise as a real window. This is the path that
        // makes "open a fresh session, watch the first reply land"
        // actually render.
        if state.bottomSeq == 0 {
            rebootstrapWindow(sessionId)
            return
        }

        if message.seq == state.bottomSeq + 1 {
            var window = messages[sessionId] ?? []
            window.append(message)
            messages[sessionId] = window
            var updated = state
            updated.bottomSeq = message.seq
            windows[sessionId] = updated
        } else if message.seq > state.bottomSeq + 1 {
            // Gap — under the post-PendingTailBuffer contract this
            // should not happen: MessageRouter funnels every live
            // push through MessageProvider.ingestTailCandidate, which
            // holds gap-creating pushes in `pendingTail` and only
            // commits a contiguous prefix back to us via `ingestBatch`.
            // A direct `append` with a gap means a code path bypassed
            // the buffer. Flag loudly in DEBUG; preserve the
            // pre-existing "leave window contiguous, mark not-at-head"
            // behavior in release as a safety net so a missed callsite
            // doesn't crash production.
            assertionFailure("MessageStore.append: gap detected (msg.seq=\(message.seq), expected=\(state.bottomSeq + 1)). All live pushes must route through MessageProvider.ingestTailCandidate.")
            var updated = state
            updated.reachedHead = false
            windows[sessionId] = updated
        } else if message.seq >= state.topSeq && message.seq <= state.bottomSeq {
            // Late re-broadcast inside our window — replace.
            var window = messages[sessionId] ?? []
            if let idx = window.firstIndex(where: { $0.seq == message.seq && $0.type == message.type }) {
                window[idx] = message
                messages[sessionId] = window
            }
        }
        // msg.seq < state.topSeq → in our DB but outside the
        // current window. Already persisted above; ignore for
        // memory.
    }

    /// Convenience overload for the raw-JSON path used by
    /// MessageRouter (it decodes envelopes upstream of the typed
    /// message machinery).
    func append(_ sessionId: String, json: Data) {
        guard let msg = ProducerMessageDecoder.decode(json) else { return }
        append(sessionId, msg)
    }

    /// Ingest a batch from a tentacle replay. Persists every
    /// persistent-type row; then patches the in-memory window if the
    /// batch overlaps or extends it. Batches that fall entirely
    /// outside the current window just go to DB.
    /// Ingest a batch from a tentacle replay. Persists every row,
    /// then patches the in-memory window if the batch extends it at
    /// either end. O(log N + K) where N is the batch size and K is
    /// the contiguous prefix/suffix that actually extends the window.
    ///
    /// **Invariants assumed of the input batch** (held by tentacle —
    /// see relay-client.ts `findTurnAlignedStart` and
    /// session-manager.ts `appendMessage`):
    /// 1. Strictly ascending `seq`. Tentacle appends with a
    ///    monotonic per-session counter and replay reads back in
    ///    that order. Asserted in DEBUG.
    /// 2. Every row is a persistent-type message with a real
    ///    `seq > 0`. Tentacle's replay path already filters
    ///    `PERSISTENT_TYPES` server-side, so the arm doesn't
    ///    re-filter. Asserted in DEBUG.
    /// 3. Content for an existing seq never changes. Tentacle's
    ///    messages.jsonl is append-only — no row is ever rewritten
    ///    after broadcast. Rows in the batch whose seq is already
    ///    inside our window are therefore byte-identical to what
    ///    we hold; they require no in-memory update.
    ///
    /// **Algorithm.** Binary-search the batch for the window's
    /// `topSeq` and `bottomSeq` boundaries (O(log N)). The two
    /// resulting slices (`< topSeq` and `> bottomSeq`) are the only
    /// rows that can extend the in-memory window; the middle slice
    /// is dropped silently because of invariant 3. We never touch
    /// rows that don't change anything.
    ///
    /// Persistence: DB upsert of the whole batch (`INSERT OR
    /// REPLACE` on the PK) handles dedup and crash-safety at the
    /// storage layer.
    func ingestBatch(_ sessionId: String, _ batch: [ChatMessage]) {
        guard !batch.isEmpty else { return }

        #if DEBUG
        for i in 0..<batch.count {
            assert(batch[i].seq > 0, "ingestBatch invariant: every row must have seq > 0 (tentacle filters non-persistent types server-side). Got seq=\(batch[i].seq) type=\(batch[i].type).")
            assert(Self.persistentTypes.contains(batch[i].type), "ingestBatch invariant: every row must be a persistent type. Got type=\(batch[i].type) seq=\(batch[i].seq).")
            if i > 0 {
                assert(batch[i - 1].seq < batch[i].seq, "ingestBatch invariant: batch must be sorted by seq ascending. Got \(batch[i - 1].seq) before \(batch[i].seq).")
            }
        }
        #endif

        try? db.insert(sessionId, batch)

        guard let state = windows[sessionId] else { return }

        // Empty bootstrap state (window placeholder set on
        // session-open against an empty DB). Rebuild from DB now
        // that content has arrived.
        if state.bottomSeq == 0 {
            rebootstrapWindow(sessionId)
            return
        }

        // Binary-split batch into three slices:
        //   [0 ..< topIdx)         seq < state.topSeq      (may extend top)
        //   [topIdx ..< botIdx)    inside window           (ignored — invariant 3)
        //   [botIdx ..< end]       seq > state.bottomSeq   (may extend bottom)
        let topIdx = batch.partitioningIndex { $0.seq >= state.topSeq }
        let botIdx = batch.partitioningIndex { $0.seq > state.bottomSeq }
        let extendsTopSlice = batch[0..<topIdx]
        let extendsBotSlice = batch[botIdx...]

        var window = messages[sessionId] ?? []
        var updated = state

        // Prepend the longest contiguous suffix of extendsTopSlice
        // that ends at state.topSeq - 1.
        if !extendsTopSlice.isEmpty, extendsTopSlice.last?.seq == state.topSeq - 1 {
            var startIdx = extendsTopSlice.endIndex - 1
            while startIdx > extendsTopSlice.startIndex,
                  extendsTopSlice[startIdx - 1].seq == extendsTopSlice[startIdx].seq - 1 {
                startIdx -= 1
            }
            let prepend = Array(extendsTopSlice[startIdx...])
            window = prepend + window
            updated.topSeq = prepend.first!.seq
            if updated.topSeq <= 1 { updated.reachedTail = true }
        }

        // Append the longest contiguous prefix of extendsBotSlice
        // that starts at state.bottomSeq + 1.
        if !extendsBotSlice.isEmpty, extendsBotSlice.first?.seq == state.bottomSeq + 1 {
            var endIdx = extendsBotSlice.startIndex
            while endIdx < extendsBotSlice.endIndex - 1,
                  extendsBotSlice[endIdx + 1].seq == extendsBotSlice[endIdx].seq + 1 {
                endIdx += 1
            }
            let append = Array(extendsBotSlice[extendsBotSlice.startIndex...endIdx])
            window.append(contentsOf: append)
            updated.bottomSeq = append.last!.seq
        }

        messages[sessionId] = window
        windows[sessionId] = updated
    }

    // MARK: - Memory window control

    /// Drop the current window entries for `sessionId` and rebuild
    /// fresh from DB. Used internally when the window is in an
    /// "empty bootstrap" state (placeholder set on session-open
    /// against an empty DB) and DB content has since arrived — we
    /// can't just append because we don't know how many sibling
    /// messages landed at the same time. Forces a fresh
    /// `loadInitialWindow` to pull the right tail.
    private func rebootstrapWindow(_ sessionId: String) {
        messages.removeValue(forKey: sessionId)
        windows.removeValue(forKey: sessionId)
        _ = loadInitialWindow(sessionId)
    }

    /// Bootstrap the window for a session: load the last `pageSize`
    /// messages from DB and seed `windows[sessionId]`. Idempotent —
    /// calling twice has no extra effect. Returns the loaded window.
    @discardableResult
    func loadInitialWindow(_ sessionId: String) -> [ChatMessage] {
        if let existing = messages[sessionId], !existing.isEmpty {
            return existing
        }
        let recent = db.recentMessages(sessionId, limit: Self.initialWindowSize)
        guard let first = recent.first, let last = recent.last else {
            // Empty session — still mark a window so live appends
            // can attach. topSeq/bottomSeq=0 means "nothing yet".
            messages[sessionId] = []
            windows[sessionId] = WindowState(topSeq: 0, bottomSeq: 0, reachedTail: true, reachedHead: false)
            return []
        }
        messages[sessionId] = recent
        windows[sessionId] = WindowState(
            topSeq: first.seq,
            bottomSeq: last.seq,
            reachedTail: first.seq <= 1,
            reachedHead: false  // caller updates after comparing to session.lastSeq
        )
        return recent
    }

    /// Pull another `pageSize` of older messages into the window.
    /// Returns whether anything was loaded. Sets `reachedTail` when
    /// DB has no more rows below the current `topSeq`.
    @discardableResult
    func loadOlder(_ sessionId: String) -> Bool {
        guard let state = windows[sessionId], !state.reachedTail, state.topSeq > 1 else { return false }
        let older = db.messages(sessionId, from: max(1, state.topSeq - Self.pageSize), to: state.topSeq - 1)
        guard !older.isEmpty else {
            var updated = state
            updated.reachedTail = true
            windows[sessionId] = updated
            return false
        }
        // older is ascending; prepend to window.
        var window = messages[sessionId] ?? []
        window = older + window
        messages[sessionId] = window
        var updated = state
        updated.topSeq = older.first!.seq
        if updated.topSeq <= 1 { updated.reachedTail = true }
        windows[sessionId] = updated
        return true
    }

    /// Pull another `pageSize` of newer messages into the window.
    /// Returns whether anything was loaded. Doesn't auto-mark
    /// reachedHead — that requires knowing the session's true
    /// `lastSeq` (caller does that comparison).
    @discardableResult
    func loadNewer(_ sessionId: String) -> Bool {
        guard let state = windows[sessionId] else { return false }
        let from = state.bottomSeq + 1
        let to = state.bottomSeq + Self.pageSize
        let newer = db.messages(sessionId, from: from, to: to)
        guard !newer.isEmpty else { return false }
        var window = messages[sessionId] ?? []
        window.append(contentsOf: newer)
        messages[sessionId] = window
        var updated = state
        updated.bottomSeq = newer.last!.seq
        windows[sessionId] = updated
        return true
    }

    /// Drop the session's window from memory. Used on session
    /// switch and explicit unload. DB content untouched.
    func unload(_ sessionId: String) {
        messages.removeValue(forKey: sessionId)
        windows.removeValue(forKey: sessionId)
    }

    /// Externally mark the head as reached (or not) — used by
    /// MessageProvider after it compares window.bottomSeq to the
    /// session's authoritative lastSeq.
    func markReachedHead(_ sessionId: String, _ reached: Bool) {
        guard var state = windows[sessionId], state.reachedHead != reached else { return }
        state.reachedHead = reached
        windows[sessionId] = state
    }

    // MARK: - Memory queries (synchronous)

    /// Returns the current window contents. Always a contiguous
    /// `[topSeq..bottomSeq]` slice of server-confirmed messages.
    /// Optimistic pending input placeholders are NOT included —
    /// callers that want to render those merge `CommandSender.outbox`
    /// at their own layer.
    func currentWindow(_ sessionId: String) -> [ChatMessage] {
        messages[sessionId] ?? []
    }

    func windowState(_ sessionId: String) -> WindowState? {
        windows[sessionId]
    }

    // MARK: - DB-only queries (no window mutation)

    /// True iff a row with this exact seq exists in DB. Used by
    /// MessageProvider to skip server fetches we already have.
    func hasInDB(_ sessionId: String, seq: Int) -> Bool {
        db.hasMessage(sessionId, seq: seq)
    }

    /// Authoritative highest persisted seq for this session.
    /// Replaces the old `getLastSeq` which mixed memory + disk.
    func dbLastSeq(_ sessionId: String) -> Int {
        db.lastSeq(sessionId)
    }

    /// Tail of the persisted message stream — used by callers that
    /// need the genuine "latest N" regardless of window state
    /// (preview rebuild, sidebar last-message-content).
    func recentFromDB(_ sessionId: String, limit: Int) -> [ChatMessage] {
        db.recentMessages(sessionId, limit: limit)
    }

    /// Decide whether the seq range `(afterSeq, +∞)` contains any
    /// "real" unread content — used by the session-list reconciler
    /// to suppress phantom unread badges for gaps that are purely
    /// tool / active churn. Mirrors the old PersistentMessageCache
    /// rule: error / permission / question / idle-following-an-
    /// agent_message all count as unread; everything else doesn't.
    func hasUnreadWorthy(_ sessionId: String, afterSeq: Int) -> Bool {
        // Range query for everything we have above afterSeq. Bounded
        // by lastSeq so we don't pull an unbounded slice.
        let last = db.lastSeq(sessionId)
        guard last > afterSeq else { return false }
        let msgs = db.messages(sessionId, from: afterSeq + 1, to: last)
        var lastNonTransientWasAgent = false
        for m in msgs {
            switch m.type {
            case "error", "permission", "question":
                return true
            case "idle":
                if lastNonTransientWasAgent { return true }
            case "agent_message":
                lastNonTransientWasAgent = true
            case "user_message":
                lastNonTransientWasAgent = false
            default:
                break
            }
        }
        return false
    }

    // MARK: - Sidebar conveniences

    /// Content of the latest `agent_message` for this session,
    /// reading from DB so callers stay accurate even when no window
    /// is open. Bounded scan (last 30 messages) — agent_messages are
    /// frequent.
    func lastAgentMessageContent(_ sessionId: String) -> String? {
        for m in db.recentMessages(sessionId, limit: 30).reversed() {
            if m.type == "agent_message" { return m.content }
        }
        return nil
    }

    /// Content of the latest `user_message` (or send_input) for
    /// this session. Same shape as `lastAgentMessageContent`.
    func lastUserMessageContent(_ sessionId: String) -> String? {
        for m in db.recentMessages(sessionId, limit: 30).reversed() {
            if m.type == "user_message" || m.type == "send_input" {
                return m.content
            }
        }
        return nil
    }

    // MARK: - Deletion

    func deleteSessionMessages(_ sessionId: String) {
        messages.removeValue(forKey: sessionId)
        windows.removeValue(forKey: sessionId)
        try? db.deleteSession(sessionId)
    }

    /// Drop everything above `seq` (memory window + DB). Used by
    /// tentacle-restart recovery so we don't trick `requestLatest`'s
    /// short-circuit with stale tail rows from a previous tentacle
    /// incarnation.
    func dropMessagesAboveSeq(_ sessionId: String, seq: Int) {
        try? db.dropAboveSeq(sessionId, seq: seq)
        if var state = windows[sessionId] {
            if state.bottomSeq > seq {
                // Trim window in memory too.
                var window = messages[sessionId] ?? []
                window.removeAll { $0.seq > seq }
                messages[sessionId] = window
                state.bottomSeq = min(state.bottomSeq, seq)
                if state.bottomSeq < state.topSeq {
                    // Window collapsed to nothing — drop it; next
                    // open will rebuild.
                    messages.removeValue(forKey: sessionId)
                    windows.removeValue(forKey: sessionId)
                } else {
                    state.reachedHead = false
                    windows[sessionId] = state
                }
            }
        }
    }

    // MARK: - Reset

    /// Wipe every in-memory window and the DB. Logout / factory
    /// reset only.
    func reset() {
        messages.removeAll()
        windows.removeAll()
        try? db.deleteAll()
    }
}

// MARK: - Binary partitioning

private extension RandomAccessCollection {
    /// Returns the first index where `predicate` is true, found via
    /// binary search. Requires that the collection is *partitioned*
    /// with respect to ` i.e. all elements for whichpredicate` 
    /// `predicate` is false come before all elements for which it
    /// is true. A sorted array satisfies this for predicates of the
    /// form `{ $0.x >= threshold }`.
    ///
    /// Returns `endIndex` when `predicate` is false for every
    /// element. O(log n).
    ///
    /// Mirrors the API in swift-algorithms; reproduced here so
    /// MessageStore stays free of extra dependencies.
    func partitioningIndex(where predicate: (Element) -> Bool) -> Index {
        var lo = startIndex
        var hi = endIndex
        while lo < hi {
            let mid = index(lo, offsetBy: distance(from: lo, to: hi) / 2)
            if predicate(self[mid]) {
                hi = mid
            } else {
                lo = index(after: mid)
            }
        }
        return lo
    }
}
