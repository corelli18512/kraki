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
    /// (deltas, pending_input, attachment_data, active, mode/title/pin
    /// updates, etc.) and lives only in memory.
    static let persistentTypes: Set<String> = [
        "session_created",
        "agent_message",
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

    private static func isPersistent(_ msg: ChatMessage) -> Bool {
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
    ///   - pending_input            → seq == 0, sorted to tail by
    ///     SortKey; always appended in memory if a window exists,
    ///     never persisted.
    func append(_ sessionId: String, _ message: ChatMessage) {
        if Self.isPersistent(message) {
            try? db.insert(sessionId, [message])
        }

        // pending_input: optimistic local placeholder, seq==0, never
        // persisted. Only meaningful while a window is open
        // (resolvePendingInput rewrites it once the server echo
        // lands).
        if message.type == "pending_input" {
            guard var window = messages[sessionId] else { return }
            window.append(message)
            messages[sessionId] = window
            return
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
            // Pending_inputs sort to the tail; insert the real
            // message before any pendings so the chronology stays
            // right.
            let insertAt = window.lastIndex(where: { $0.type != "pending_input" }).map { $0 + 1 } ?? 0
            window.insert(message, at: insertAt)
            messages[sessionId] = window
            var updated = state
            updated.bottomSeq = message.seq
            windows[sessionId] = updated
        } else if message.seq > state.bottomSeq + 1 {
            // Gap — leave window contiguous; mark "not at head" so
            // the UI knows there's more to fetch.
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
    func ingestBatch(_ sessionId: String, _ batch: [ChatMessage]) {
        guard !batch.isEmpty else { return }
        let persistent = batch.filter(Self.isPersistent)
        try? db.insert(sessionId, persistent)

        guard let state = windows[sessionId] else { return }

        // Empty bootstrap state (window was set up against an empty
        // DB at session-open time). Now that DB has content, build a
        // real window from the tail.
        if state.bottomSeq == 0 {
            rebootstrapWindow(sessionId)
            return
        }

        // Split the batch by relation to the current window.
        var extendsTop: [ChatMessage] = []     // < topSeq, immediately adjacent
        var insideWindow: [ChatMessage] = []   // inside [topSeq, bottomSeq]
        var extendsBottom: [ChatMessage] = []  // > bottomSeq, immediately adjacent

        for msg in batch where Self.isPersistent(msg) {
            if msg.seq < state.topSeq {
                extendsTop.append(msg)
            } else if msg.seq > state.bottomSeq {
                extendsBottom.append(msg)
            } else {
                insideWindow.append(msg)
            }
        }

        var window = messages[sessionId] ?? []
        var updated = state

        // Prepend tail-end of extendsTop that's contiguous with topSeq.
        if !extendsTop.isEmpty {
            let sorted = extendsTop.sorted { $0.seq < $1.seq }
            // Find the longest suffix that ends at topSeq - 1.
            if sorted.last?.seq == state.topSeq - 1 {
                // Walk back to find the contiguous head of the suffix.
                var contiguousStart = sorted.count - 1
                while contiguousStart > 0,
                      sorted[contiguousStart - 1].seq == sorted[contiguousStart].seq - 1 {
                    contiguousStart -= 1
                }
                let prepend = Array(sorted[contiguousStart...])
                window = prepend + window
                updated.topSeq = prepend.first!.seq
                if updated.topSeq <= 1 { updated.reachedTail = true }
            }
            // Anything left in extendsTop is non-contiguous below
            // the window — already in DB, ignore.
        }

        // Dedup-replace insideWindow rows.
        if !insideWindow.isEmpty {
            var byKey: [String: ChatMessage] = [:]
            for m in insideWindow { byKey["\(m.seq)|\(m.type)"] = m }
            for i in window.indices where window[i].type != "pending_input" {
                let key = "\(window[i].seq)|\(window[i].type)"
                if let replacement = byKey[key] { window[i] = replacement }
            }
        }

        // Append head-end of extendsBottom that's contiguous with bottomSeq.
        if !extendsBottom.isEmpty {
            let sorted = extendsBottom.sorted { $0.seq < $1.seq }
            if sorted.first?.seq == state.bottomSeq + 1 {
                var contiguousEnd = 0
                while contiguousEnd < sorted.count - 1,
                      sorted[contiguousEnd + 1].seq == sorted[contiguousEnd].seq + 1 {
                    contiguousEnd += 1
                }
                let append = Array(sorted[...contiguousEnd])
                // Pendings go after.
                let insertAt = window.lastIndex(where: { $0.type != "pending_input" }).map { $0 + 1 } ?? window.count
                window.insert(contentsOf: append, at: insertAt)
                updated.bottomSeq = append.last!.seq
            }
        }

        messages[sessionId] = window
        windows[sessionId] = updated
    }

    // MARK: - Resolution stamps (on existing messages in window)

    /// Stamp `resolution` on the matching permission message *if it's
    /// in the current window*. The DB copy is not rewritten — the
    /// payload there reflects the moment of insert, and clients re-
    /// hydrating later can re-derive resolution from subsequent
    /// approve/deny/permission_resolved rows.
    ///
    /// (Future improvement: also update the DB payload so even a
    /// cold-start window-load shows the resolution stamp; deferred
    /// until a concrete bug demands it.)
    func resolvePermissionMessage(_ sessionId: String, permissionId: String, resolution: String) {
        guard var window = messages[sessionId] else { return }
        var changed = false
        for i in stride(from: window.count - 1, through: 0, by: -1) {
            let m = window[i]
            if m.type == "permission" && m.permissionId == permissionId {
                var updated = m
                updated.payload["resolution"] = AnyCodable(resolution)
                window[i] = updated
                changed = true
                break
            }
        }
        if changed { messages[sessionId] = window }
    }

    func resolveQuestionMessage(_ sessionId: String, questionId: String, answerText: String) {
        guard var window = messages[sessionId] else { return }
        var changed = false
        for i in stride(from: window.count - 1, through: 0, by: -1) {
            let m = window[i]
            if m.type == "question" && m.questionId == questionId {
                var updated = m
                updated.payload["answer"] = AnyCodable(answerText)
                window[i] = updated
                changed = true
                break
            }
        }
        if changed { messages[sessionId] = window }
    }

    /// Convenience overload for callers that pass `String?` (mostly
    /// MessageRouter handling answer envelopes with optional text).
    func resolveQuestionMessage(_ sessionId: String, questionId: String, answer: String?) {
        resolveQuestionMessage(sessionId, questionId: questionId, answerText: answer ?? "")
    }

    // MARK: - Pending input (optimistic local placeholder)

    /// Replace a `pending_input` (clientId/content-matched) with the
    /// server's persisted `user_message`. Returns true if a pending
    /// was actually resolved; the caller (MessageRouter) uses that to
    /// skip appending the broadcast (which would otherwise
    /// duplicate). Always persists the resolved message regardless of
    /// window state — the server seq is authoritative.
    @discardableResult
    func resolvePendingInput(_ sessionId: String,
                             seq: Int,
                             clientId: String?,
                             content: String?) -> Bool {
        // Find and rewrite the in-window pending (if any).
        var rewrittenInWindow = false
        var resolved: ChatMessage?
        if var window = messages[sessionId] {
            let idx: Int?
            if let clientId {
                idx = window.firstIndex(where: { $0.type == "pending_input" && $0.clientId == clientId })
            } else if let content {
                idx = window.firstIndex(where: { $0.type == "pending_input" && $0.content == content })
            } else {
                idx = nil
            }
            if let idx {
                let pending = window[idx]
                var newPayload = pending.payload
                if let content { newPayload["content"] = AnyCodable(content) }
                newPayload.removeValue(forKey: "clientId")
                let real = ChatMessage(
                    type: "user_message",
                    seq: seq,
                    sessionId: sessionId,
                    deviceId: pending.deviceId,
                    timestamp: pending.timestamp,
                    payload: newPayload
                )
                resolved = real
                // Remove the pending; the real one will be inserted
                // by append() in the right sorted spot.
                window.remove(at: idx)
                messages[sessionId] = window
                rewrittenInWindow = true
            }
        }

        if let resolved {
            // Persist + integrate into window via the normal path.
            append(sessionId, resolved)
            return true
        }
        return rewrittenInWindow
    }

    /// Legacy single-arg overload — kept for backwards compat with
    /// any caller that hasn't migrated to passing clientId yet.
    func resolvePendingInput(_ sessionId: String, seq: Int) {
        guard let window = messages[sessionId],
              let pending = window.first(where: { $0.type == "pending_input" }) else { return }
        _ = resolvePendingInput(sessionId, seq: seq, clientId: pending.clientId, content: pending.content)
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
        let insertAt = window.lastIndex(where: { $0.type != "pending_input" }).map { $0 + 1 } ?? window.count
        window.insert(contentsOf: newer, at: insertAt)
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
    /// `[topSeq..bottomSeq]` slice (plus any trailing pendings).
    func currentWindow(_ sessionId: String) -> [ChatMessage] {
        messages[sessionId] ?? []
    }

    func windowState(_ sessionId: String) -> WindowState? {
        windows[sessionId]
    }

    func hasPendingInput(_ sessionId: String) -> Bool {
        messages[sessionId]?.contains(where: { $0.type == "pending_input" }) ?? false
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
                window.removeAll { $0.type != "pending_input" && $0.seq > seq }
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

    /// Wipe transient state without touching persisted history.
    /// Currently only pending_inputs — old code also dropped the
    /// pending dicts here, but those no longer exist.
    func clearTransientState() {
        for (sessionId, var window) in messages {
            let before = window.count
            window.removeAll { $0.type == "pending_input" }
            if window.count != before {
                messages[sessionId] = window
            }
        }
    }
}
