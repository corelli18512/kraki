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

enum CompactionReason: String, Equatable {
    case manual
    case threshold
    case overflow
}

enum SessionRuntimeStatus: Equatable {
    case idle
    case compacting(reason: CompactionReason?)
}

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
        "system_message",
        "error",
        "session_ended",
        "idle",
    ]

    static func isPersistent(_ msg: ChatMessage) -> Bool {
        msg.seq > 0 && persistentTypes.contains(msg.type)
    }

    private static let initialWindowSize = 200
    /// Maximum count of in-memory window before `expandWindow` trims
    /// the opposite end. DB still has everything; trimmed rows can
    /// be pulled back via `dbMessages` on the next ensureOlder/Newer.
    /// This is the legacy COUNT cap, used as the sole cap when no height
    /// oracle is injected (see `heightForSeq`).
    static let maxWindowSize = 1000
    /// Loose count ceiling used only in px mode (when `heightForSeq` is set):
    /// a hard memory backstop set far above any realistic px-managed window so
    /// it never trims normally, only if rendered heights never warm.
    static let pxModeCountCeiling = 4000

    /// Optional per-seq rendered-height oracle, injected by the view. Returns
    /// the rendered px attributed to a single seq (a turn's whole height is
    /// attributed to its end seq; other seqs in the turn report 0), so summing
    /// over the window yields total rendered px. When set, `expandWindow` caps
    /// the window by `maxWindowPx` (rendered height) instead of message count —
    /// the fix for tall-turn windows collapsing below one screen. Heights warm
    /// async; a not-yet-measured seq reports 0 (the px-trim then under-trims =
    /// a transiently larger window, which is safe — only too-SMALL windows
    /// cause the paging ping-pong).
    var heightForSeq: ((String, Int) -> CGFloat)?
    /// Target max rendered height of the in-memory window (px), enforced when
    /// `heightForSeq` is set. ~14 screens; keeps both paging edges far apart so
    /// applies stay incremental. `.infinity` (default) disables the px cap.
    var maxWindowPx: CGFloat = .infinity


    // MARK: - Live write

    /// Append a single live message. Always persists (if persistent
    /// type); only materialises into the in-memory window when the
    /// session has an active window AND the message extends it
    /// contiguously at the tail.
    ///
    /// Active-window decision:
    ///   - msg.seq == bottomSeq + 1 → append into window; bump
    ///     bottomSeq.
    ///   - msg.seq > bottomSeq + 1  → gap, leave the window alone
    ///     so it stays contiguous; MessageProvider's PendingTailBuffer
    ///     will route this through `ingestTailCandidate` instead.
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
            // the buffer. Flag loudly in DEBUG; preserve "leave
            // window contiguous" behavior in release as a safety net.
            assertionFailure("MessageStore.append: gap detected (msg.seq=\(message.seq), expected=\(state.bottomSeq + 1)). All live pushes must route through MessageProvider.ingestTailCandidate.")
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
    func ingestBatch(_ sessionId: String, _ rawBatch: [ChatMessage]) {
        // Structural guarantee: only spine messages ever reach the window/DB.
        // Tools / narration / permission / question are off-spine (card + trace)
        // and must never enter here, regardless of what the wire delivers.
        let batch = rawBatch.filter(Self.isPersistent)
        guard !batch.isEmpty else { return }

        persist(sessionId, batch)

        // Empty bootstrap state (window placeholder set on
        // session-open against an empty DB). Rebuild from DB now
        // that content has arrived. Must happen *after* persist so
        // the freshly-inserted rows are visible to loadInitialWindow.
        if let state = windows[sessionId], state.bottomSeq == 0 {
            rebootstrapWindow(sessionId)
            return
        }

        expandWindow(sessionId, batch)
    }

    /// Persist a batch to disk only. No window mutation. Used by
    /// `ingestBatch` for the "received from WS" path; can also be
    /// called directly when the caller wants DB writes without
    /// touching the active window (e.g. background replay).
    func persist(_ sessionId: String, _ batch: [ChatMessage]) {
        guard !batch.isEmpty else { return }

        #if DEBUG
        for i in 0..<batch.count {
            assert(batch[i].seq > 0, "persist invariant: every row must have seq > 0 (tentacle filters non-persistent types server-side). Got seq=\(batch[i].seq) type=\(batch[i].type).")
            assert(Self.persistentTypes.contains(batch[i].type), "persist invariant: every row must be a persistent type. Got type=\(batch[i].type) seq=\(batch[i].seq).")
            if i > 0 {
                assert(batch[i - 1].seq < batch[i].seq, "persist invariant: batch must be sorted by seq ascending. Got \(batch[i - 1].seq) before \(batch[i].seq).")
            }
        }
        #endif

        try? db.insert(sessionId, batch)
    }

    /// Extend the in-memory window with rows from `batch` that
    /// adjoin either end of the current window. **No DB write.**
    /// Used both by `ingestBatch` (after persist) and by the
    /// DB-first paths in `MessageProvider.ensureOlderLoaded` /
    /// `ensureNewerLoaded` where the rows are already in DB and we
    /// only need to expose them to the window.
    ///
    /// Batches that don't adjoin either end leave the window
    /// untouched and emit a 🪢 ⚠️ warning so a buggy caller is
    /// visible. Rows of `batch` that fall inside the current window
    /// are silently ignored (invariant 3 — already byte-identical).
    ///
    /// After extension, if the window exceeds `maxWindowSize`, the
    /// opposite end is trimmed back to the cap. DB still has the
    /// trimmed rows; the next ensureOlder/Newer can pull them.
    func expandWindow(_ sessionId: String, _ batch: [ChatMessage]) {
        guard !batch.isEmpty else { return }
        guard let state = windows[sessionId] else { return }
        // Bootstrap state is handled by `ingestBatch` (rebootstrap
        // path). DB-first callers (ensureOlder/Newer) only fire on
        // an already-populated window.
        guard state.bottomSeq > 0 else { return }

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
        var didPrepend = false
        var didAppend = false

        // Prepend the longest contiguous suffix of extendsTopSlice
        // that ends at state.topSeq - 1.
        var prependedCount = 0
        if !extendsTopSlice.isEmpty, extendsTopSlice.last?.seq == state.topSeq - 1 {
            var startIdx = extendsTopSlice.endIndex - 1
            while startIdx > extendsTopSlice.startIndex,
                  extendsTopSlice[startIdx - 1].seq == extendsTopSlice[startIdx].seq - 1 {
                startIdx -= 1
            }
            let prepend = Array(extendsTopSlice[startIdx...])
            window = prepend + window
            updated.topSeq = prepend.first!.seq
            didPrepend = true
            prependedCount = prepend.count
        }

        // Append the longest contiguous prefix of extendsBotSlice
        // that starts at state.bottomSeq + 1.
        var appendedCount = 0
        if !extendsBotSlice.isEmpty, extendsBotSlice.first?.seq == state.bottomSeq + 1 {
            var endIdx = extendsBotSlice.startIndex
            while endIdx < extendsBotSlice.endIndex - 1,
                  extendsBotSlice[endIdx + 1].seq == extendsBotSlice[endIdx].seq + 1 {
                endIdx += 1
            }
            let append = Array(extendsBotSlice[extendsBotSlice.startIndex...endIdx])
            window.append(contentsOf: append)
            updated.bottomSeq = append.last!.seq
            didAppend = true
            appendedCount = append.count
        }

        // Sanity: batch had rows outside the window but neither end
        // could be extended → the window is in "history mode" (e.g.
        // user scrolled up far enough for the trim cap to move
        // `bottomSeq` below `dbLastSeq`) and this batch is a live
        // push that landed above. Persist already wrote it to DB; the
        // window stays where the user left it. When they scroll back
        // toward the tail, `ensureNewerLoaded` will surface these
        // rows from DB. This is **expected and correct** — the
        // window is a render cache, not the live-tail attach point.
        // Logged at DEBUG level only for diagnostics.
        if !didPrepend && !didAppend && (!extendsTopSlice.isEmpty || !extendsBotSlice.isEmpty) {
            let bFrom = batch.first?.seq ?? -1
            let bTo = batch.last?.seq ?? -1
            KLog.d("expandWindow non-adjacent (history-mode, expected): session=\(sessionId.prefix(12)) batch=[\(bFrom)…\(bTo)] window=[\(state.topSeq)…\(state.bottomSeq)] dropped=\(extendsTopSlice.count + extendsBotSlice.count)")
            return
        }

        // Enforce the window cap. Trim the OPPOSITE end of whichever side we
        // just extended (the far edge — off-screen, since paging approaches the
        // edge it extends). DB still has the trimmed rows; the next
        // ensureOlder/Newer can pull them back.
        //
        // PRIMARY: px-based. When the view has injected `heightForSeq` (rendered
        // px attributed per seq), keep total rendered height under `maxWindowPx`
        // — so a window of a few TALL turns and a window of many SHORT turns both
        // stay ≈ the same number of SCREENS (not a fixed message count, which
        // for tall turns could be < a screen → the two paging edges co-fire =
        // the ping-pong/crash). The trim mirrors the validated ScrollPerfTest
        // engine: SLIDE not leap — remove at most the page we just added (so the
        // window slides rather than collapses) and keep ≥1 of the pre-call rows
        // as overlap, so a single update never swaps the whole window.
        if let h = heightForSeq, maxWindowPx.isFinite {
            func windowPx() -> CGFloat { window.reduce(0) { $0 + h(sessionId, $1.seq) } }
            if didAppend {
                // Extended the bottom → trim the TOP (older rows, off-screen
                // above). Keep ≥1 old row; remove ≤ the page we just appended.
                let oldCount = window.count - appendedCount
                let maxRemove = min(appendedCount, max(0, oldCount - 1))
                var removed = 0
                while removed < maxRemove, window.count > 1, windowPx() > maxWindowPx {
                    window.removeFirst()
                    updated.topSeq = window.first!.seq
                    removed += 1
                }
            } else if didPrepend {
                // Extended the top → trim the BOTTOM (newer rows, off-screen
                // below). Keep ≥1 old row; remove ≤ the page we just prepended.
                let oldCount = window.count - prependedCount
                let maxRemove = min(prependedCount, max(0, oldCount - 1))
                var removed = 0
                while removed < maxRemove, window.count > 1, windowPx() > maxWindowPx {
                    window.removeLast()
                    updated.bottomSeq = window.last!.seq
                    removed += 1
                }
            }
        }

        // SAFETY CEILING: a hard count cap, always enforced. With no injected
        // heights it is the sole cap (legacy behaviour, `maxWindowSize`). In px
        // mode it is a loose backstop set well above any realistic px-managed
        // size (so it never bites normally) that still bounds memory if heights
        // never warm (every `heightForSeq` returns 0 → px-trim is a no-op).
        let countCeiling = heightForSeq != nil ? Self.pxModeCountCeiling : Self.maxWindowSize
        if window.count > countCeiling {
            let overflow = window.count - countCeiling
            if didAppend {
                window.removeFirst(overflow)
                updated.topSeq = window.first!.seq
            } else if didPrepend {
                window.removeLast(overflow)
                updated.bottomSeq = window.last!.seq
            }
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

    /// Reset the in-memory window for `sessionId` to the most recent
    /// `initialWindowSize` rows currently in DB. Equivalent of "jump
    /// to bottom" — discards whatever older slice the user had
    /// scrolled to and rebuilds the standard tail-anchored window.
    /// DB content untouched. Caller is responsible for any follow-up
    /// fetch needed to fill content beyond DB's current tail.
    func resetWindowToHead(_ sessionId: String) {
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
            windows[sessionId] = WindowState(topSeq: 0, bottomSeq: 0)
            return []
        }
        messages[sessionId] = recent
        windows[sessionId] = WindowState(
            topSeq: first.seq,
            bottomSeq: last.seq
        )
        return recent
    }

    /// Drop the session's window from memory. Used on session
    /// switch and explicit unload. DB content untouched.
    func unload(_ sessionId: String) {
        messages.removeValue(forKey: sessionId)
        windows.removeValue(forKey: sessionId)
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

    /// Range query against the persistent store. Returns rows whose
    /// `seq` falls in `[from...to]`, ascending. **No contiguity
    /// guarantee** — DB rows may have holes (e.g. a session that was
    /// only partially backfilled). Callers (typically
    /// `MessageProvider.ensureOlderLoaded` / `ensureNewerLoaded`)
    /// must inspect the returned slice to decide whether a WS
    /// escalation is needed.
    func dbMessages(_ sessionId: String, from: Int, to: Int) -> [ChatMessage] {
        db.messages(sessionId, from: from, to: to)
    }

    /// Decide whether the seq range `(afterSeq, +∞)` contains any
    /// "real" unread content. Pure-spine model: only `error`, or an
    /// `idle` that closes a turn which produced an agent reply, count.
    func hasUnreadWorthy(_ sessionId: String, afterSeq: Int) -> Bool {
        let last = db.lastSeq(sessionId)
        guard last > afterSeq else { return false }
        let msgs = db.messages(sessionId, from: afterSeq + 1, to: last)
        var lastWasAgent = false
        for m in msgs {
            switch m.type {
            case "error":
                return true
            case "idle":
                if lastWasAgent { return true }
            case "agent_message", "system_message":
                lastWasAgent = true
            case "user_message":
                lastWasAgent = false
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
        runtimeStatusBySession.removeValue(forKey: sessionId)
        cards.removeValue(forKey: sessionId)
        traces.removeValue(forKey: sessionId)
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
                    windows[sessionId] = state
                }
            }
        }
    }

    // MARK: - Runtime status + live card + trace (ephemeral, never persisted)

    /// Session-scoped runtime activity. This is deliberately separate from the
    /// conversation spine, TRACE, and the live card action slot. In particular,
    /// compaction must never create a bubble or displace a tool/human prompt.
    var runtimeStatusBySession: [String: SessionRuntimeStatus] = [:]

    func runtimeStatus(_ sessionId: String) -> SessionRuntimeStatus {
        runtimeStatusBySession[sessionId] ?? .idle
    }

    func setCompacting(_ sessionId: String, reason: CompactionReason?) {
        runtimeStatusBySession[sessionId] = .compacting(reason: reason)
    }

    func clearRuntimeStatusIfCompacting(_ sessionId: String) {
        guard case .compacting = runtimeStatusBySession[sessionId] else { return }
        runtimeStatusBySession.removeValue(forKey: sessionId)
    }

    func clearRuntimeStatus(_ sessionId: String) {
        runtimeStatusBySession.removeValue(forKey: sessionId)
    }

    /// Compatibility decoder for current Tentacles, which transport compaction
    /// through `card_action`. Route the two state domains atomically:
    /// compaction updates only runtime status; ordinary actions update only the
    /// card and prove any stale compaction status is over.
    func applyCardAction(_ sessionId: String, _ action: ChatMessage?) {
        guard let action else {
            clearRuntimeStatusIfCompacting(sessionId)
            setCardAction(sessionId, nil)
            return
        }
        if action.type == "compaction" {
            let reason = action.payload["reason"]?.stringValue.flatMap(CompactionReason.init(rawValue:))
            setCompacting(sessionId, reason: reason)
            return
        }
        clearRuntimeStatusIfCompacting(sessionId)
        setCardAction(sessionId, action)
    }

    /// The server-owned status card for the in-progress turn: the live draft
    /// text (keep-last narration) plus the single action slot. Pure pass-through
    /// — the client derives nothing, just holds what the tentacle sent and
    /// clears it when the concluding bubble lands. Never written to DB.
    struct SessionCard: Equatable {
        var text: String = ""
        /// One of tool_start / tool_complete / tool_batch / permission /
        /// question, carried verbatim as a `ChatMessage` (type + payload).
        var action: ChatMessage?
    }
    var cards: [String: SessionCard] = [:]
    /// A concluded turn rejects late coalesced deltas/card snapshots so its
    /// transient draft cannot reappear below the permanent spine bubble.
    /// Reopened only by the next persisted user_message.
    private var closedCardTurns: Set<String> = []

    /// Per-turn TRACE steps, lazily pulled via `turn_trace_batch` and keyed by
    /// the concluding bubble's spine seq. In-memory only — the "Steps" popup
    /// re-pulls; nothing here is persisted.
    var traces: [String: [Int: [ChatMessage]]] = [:]

    /// Reopen transient draft/action state for an accepted user input. A normal
    /// prompt starts a fresh turn and clears stale card state; a steer is a
    /// visible interjection inside the current lifecycle and must preserve the
    /// active draft/action while only reopening the late-frame gate.
    func beginCardTurn(_ sessionId: String, delivery: String? = nil) {
        closedCardTurns.remove(sessionId)
        if delivery != "steer" { cards.removeValue(forKey: sessionId) }
    }

    /// Permanently retire transient state for the concluded turn. Late WS
    /// coalescing or request_card snapshots are ignored until beginCardTurn.
    func endCardTurn(_ sessionId: String) {
        closedCardTurns.insert(sessionId)
        cards.removeValue(forKey: sessionId)
    }

    /// Restore the gate from persisted conversation truth when opening a DB
    /// window. `session.state == active` is not sufficient because a reconnect
    /// snapshot may race after the preceding turn already concluded.
    func restoreCardTurnGate(_ sessionId: String, from messages: [ChatMessage]) {
        guard let boundary = messages.last(where: {
            ["user_message", "agent_message", "turn_status", "interrupted_turn",
             "system_message", "idle", "session_ended"].contains($0.type)
        }) else { return }
        if boundary.type == "user_message" {
            closedCardTurns.remove(sessionId)
        } else {
            endCardTurn(sessionId)
        }
    }

    /// `agent_message_delta`: append the chunk, or replace the draft when
    /// `reset` (new segment / resummarize / reconnect snapshot). Keep-last.
    func applyCardMessage(_ sessionId: String, _ content: String, reset: Bool) {
        guard !closedCardTurns.contains(sessionId) else { return }
        // Non-empty model output proves the runtime advanced beyond compaction.
        if !content.isEmpty { clearRuntimeStatusIfCompacting(sessionId) }
        var card = cards[sessionId] ?? SessionCard()
        card.text = reset ? content : card.text + content
        cards[sessionId] = card
    }

    /// `card_action`: set (or clear) the single action slot verbatim.
    func setCardAction(_ sessionId: String, _ action: ChatMessage?) {
        guard !closedCardTurns.contains(sessionId) else { return }
        var card = cards[sessionId] ?? SessionCard()
        card.action = action
        cards[sessionId] = card
    }

    /// Atomically replace transient card state from a successful subscription
    /// ACK. Unlike incremental delta/action handlers this is an authoritative
    /// reconnect/page-entry snapshot, so it may reopen the card gate when the
    /// digest says a turn is live and the snapshot actually carries draft or
    /// action state. Empty idle/ended snapshots keep the concluded-turn gate
    /// closed and can never resurrect a stale bubble.
    func replaceCardFromSubscription(
        _ sessionId: String,
        draft: String,
        action: ChatMessage?,
        state: SessionState
    ) {
        cards.removeValue(forKey: sessionId)
        let hasLiveCard = !draft.isEmpty || action != nil
        let liveState = state == .active || state == .compacting
        guard liveState && hasLiveCard else {
            if !liveState { closedCardTurns.insert(sessionId) }
            return
        }
        closedCardTurns.remove(sessionId)
        cards[sessionId] = SessionCard(text: draft, action: action)
    }

    /// Land-and-clear: the concluding bubble landed on the spine, drop the card.
    func clearCard(_ sessionId: String) {
        cards.removeValue(forKey: sessionId)
    }

    /// `turn_trace_batch`: replace a turn's pulled steps.
    func setTurnSteps(_ sessionId: String, bubbleSeq: Int, _ entries: [ChatMessage]) {
        traces[sessionId, default: [:]][bubbleSeq] = entries
    }

    /// A turn's pulled steps, or nil if not pulled yet.
    func turnSteps(_ sessionId: String, bubbleSeq: Int) -> [ChatMessage]? {
        traces[sessionId]?[bubbleSeq]
    }

    // MARK: - Reset

    /// Wipe every in-memory window and the DB. Logout / factory
    /// reset only.
    func reset() {
        runtimeStatusBySession.removeAll()
        cards.removeAll()
        closedCardTurns.removeAll()
        traces.removeAll()
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
