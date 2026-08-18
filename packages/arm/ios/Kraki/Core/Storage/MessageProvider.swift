/// MessageProvider — Manages lazy message loading, mirroring message-provider.ts.
///
/// Provides a unified interface for loading session messages:
///   - requestLatest: load last 50 messages (called after session_list)
///   - requestBefore: load 100 older messages (called from gap marker)
///   - handleBatch: process replay batch from tentacle
///
/// Tracks tentacle last-seq per session and prevents duplicate requests.

import Foundation

final class MessageProvider {
    private static let pageSize = 100
    private static let latestSize = 50

    // MARK: - Outstanding-request state

    /// Kind of in-flight WS request for a session.
    enum OutstandingKind: Hashable {
        /// `request_session_messages(beforeSeq: nil)` — head / latest fetch.
        case head
        /// `request_session_messages(beforeSeq: X)` — paginate older history.
        case before(Int)
        /// `request_session_messages_range(fromSeq, toSeq)` — bridge a
        /// known gap detected by `PendingTailBuffer`.
        case range(ClosedRange<Int>)
    }

    /// One outstanding WS request plus its safety timeout.
    struct RequestSlot {
        let kind: OutstandingKind
        let timeout: DispatchWorkItem
    }

    /// Per-session list of outstanding WS requests. A session may
    /// have multiple `.head`/`.before` slots simultaneously (the chat
    /// view might page older while a head fetch is still resolving),
    /// but **at most one `.range`** by design — the gap-bridge loop
    /// in `PendingTailBuffer` serialises range fetches.
    ///
    /// This single source of truth replaces five legacy dicts/sets
    /// (`inFlightRequests`, `pendingHeadRequests`, `timeoutTasks`,
    /// `inflightRange`, `rangeTimeoutTasks`). All inflight gates,
    /// "is loading" predicates, and timeout cleanup go through here.
    private var outstanding: [String: [RequestSlot]] = [:]

    /// Per-session highest known seq on the tentacle (from session_list).
    private var tentacleLastSeq: [String: Int] = [:]

    /// Per-session single-flight guard for the DB-first older-history
    /// path (`ensureOlderLoadedAsync`). Distinct from the WS `.before`
    /// slot gate (`isLoadingOlder`): the DB path resolves locally and
    /// never creates a slot, so without this a fast flick would spawn
    /// overlapping background reads.
    private var loadingOlderDB: Set<String> = []

    /// Per-turn trace pulls already issued (dedup), keyed `sid:bubbleSeq`.
    private var tracePulled: Set<String> = []
    /// Sessions whose live card snapshot has been requested (dedup).
    private var cardRequested: Set<String> = []

    /// Per-session push-gap recovery buffer. Pure data — all the
    /// network I/O and timeout machinery lives in this provider; the
    /// buffer just decides what to commit and what to fetch next.
    /// See `PendingTailBuffer` for the algorithm.
    private var pendingTail: [String: PendingTailBuffer] = [:]

    private weak var appState: AppState?

    init(appState: AppState) {
        self.appState = appState
    }

    // MARK: - Outstanding-slot helpers

    /// Insert a slot under `sessionId`. Caller is responsible for the
    /// caller-side dedup decisions (e.g. requestBefore's per-beforeSeq
    /// check, ensureOlderLoaded's per-session before gate).
    private func addSlot(_ sessionId: String, _ slot: RequestSlot) {
        outstanding[sessionId, default: []].append(slot)
    }

    /// Remove the **first** slot whose `kind` matches `match`. Cancels
    /// the slot's timeout. Returns the removed kind for callers that
    /// need to react (e.g. `handleBatch` derives `wasHeadRequest`).
    @discardableResult
    private func removeFirstSlot(_ sessionId: String, where match: (OutstandingKind) -> Bool) -> OutstandingKind? {
        guard var slots = outstanding[sessionId] else { return nil }
        guard let idx = slots.firstIndex(where: { match($0.kind) }) else { return nil }
        let removed = slots.remove(at: idx)
        removed.timeout.cancel()
        if slots.isEmpty {
            outstanding.removeValue(forKey: sessionId)
        } else {
            outstanding[sessionId] = slots
        }
        return removed.kind
    }

    /// True if any slot for `sessionId` matches `match`. Cheap; the
    /// per-session list is typically 0–3 entries.
    private func hasSlot(_ sessionId: String, where match: (OutstandingKind) -> Bool) -> Bool {
        guard let slots = outstanding[sessionId] else { return false }
        return slots.contains { match($0.kind) }
    }

    /// Count of outstanding slots in `sessionId` matching `match`.
    /// Used by diagnostic logs and the test page.
    private func slotCount(_ sessionId: String, where match: (OutstandingKind) -> Bool) -> Int {
        outstanding[sessionId]?.reduce(0) { match($1.kind) ? $0 + 1 : $0 } ?? 0
    }

    /// Public diagnostic: snapshot the kinds outstanding for a
    /// session. Used by `SlidingWindowTestView` to verify dedup.
    func outstandingKinds(_ sessionId: String) -> [OutstandingKind] {
        outstanding[sessionId]?.map(\.kind) ?? []
    }

    /// Remove the turn-aligned request slot answered by a batch. The response
    /// does not echo `beforeSeq`, and historical logs may contain off-spine
    /// events whose seqs are filtered from `messages`, so `lastSeq + 1` is not
    /// a valid way to recover the request boundary. For an older response,
    /// choose the nearest outstanding `beforeSeq` strictly above the last
    /// returned persistent seq; UX paging permits only one such slot in flight.
    private func removeTurnAlignedSlot(
        _ sessionId: String,
        containsHead: Bool?,
        lastPersistentSeq: Int
    ) -> OutstandingKind? {
        if containsHead == true {
            return removeFirstSlot(sessionId) { if case .head = $0 { return true }; return false }
        }
        if containsHead == nil,
           hasSlot(sessionId, where: { if case .head = $0 { return true }; return false }) {
            return removeFirstSlot(sessionId) { if case .head = $0 { return true }; return false }
        }
        let candidates = outstanding[sessionId, default: []].compactMap { slot -> Int? in
            guard case .before(let beforeSeq) = slot.kind else { return nil }
            if lastPersistentSeq <= 0 || beforeSeq > lastPersistentSeq { return beforeSeq }
            return nil
        }
        guard let matched = candidates.min() else { return nil }
        return removeFirstSlot(sessionId) { $0 == .before(matched) }
    }

    // MARK: - Configuration

    /// Update tentacle metadata from session_list.
    ///
    /// Tentacle-restart recovery: if the reported `lastSeq` is LOWER
    /// than what our in-memory store believes (post-`getLastSeq` which
    /// already filters to persistent types), our cache holds stale
    /// entries from a previous tentacle incarnation or pollution from
    /// pre-fix builds. Purge anything above the tentacle's lastSeq so
    /// `requestLatest`'s `storeLastSeq >= tentacleLastSeq` guard
    /// doesn't short-circuit and silently swallow the gap.
    func setTentacleInfo(sessionId: String, lastSeq: Int, deviceId: String) {
        if let appState, lastSeq > 0 {
            let storeLastSeq = appState.messageStore.dbLastSeq(sessionId)
            if storeLastSeq > lastSeq {
                KLog.d("🧹 setTentacleInfo(\(sessionId.prefix(12))): store=\(storeLastSeq) > tentacle=\(lastSeq) — purging stale tail")
                appState.messageStore.dropMessagesAboveSeq(sessionId, seq: lastSeq)
            }
        }
        let oldLastSeq = tentacleLastSeq[sessionId]
        tentacleLastSeq[sessionId] = lastSeq
        if let oldLastSeq, oldLastSeq != lastSeq {
            KLog.d("🏷️ [2/history setTentacleInfo] session=\(sessionId.prefix(12)) lastSeq=\(oldLastSeq)→\(lastSeq) device=\(deviceId.prefix(12))")
        } else if oldLastSeq == nil {
            KLog.d("🏷️ [2/history setTentacleInfo] session=\(sessionId.prefix(12)) lastSeq=nil→\(lastSeq) device=\(deviceId.prefix(12))")
        }

        // Reset in-flight range tracking on every session_list. Reasons:
        //   1. After a WS reconnect, any previously-pending range
        //      request will never get a response — we must clear the
        //      `.range` slot so the drain loop can re-trigger.
        //   2. The tentacle deviceId may have changed (rare but
        //      possible if the tentacle restarted under a new
        //      identity). Anything already in flight was addressed
        //      to a stale device.
        // `.head`/`.before` slots are intentionally NOT cleared here
        // — they're idempotent and the 10s safety timeout handles
        // any actually-dropped responses.
        // Then re-drain in case pendingTail has content that's
        // waiting on a fresh fetch.
        removeFirstSlot(sessionId) { if case .range = $0 { return true }; return false }
        if !(pendingTail[sessionId]?.isEmpty ?? true) {
            drainPendingTail(sessionId)
        }
    }

    /// Live-message observer: called from `MessageRouter` every time a durable
    /// spine push lands (user_message, agent_message, idle, terminal status,
    /// etc.). Off-spine tool/card/trace traffic never enters this path. Bumps
    /// `tentacleLastSeq` up to the new
    /// seq so the `at-head` check in `requestLatest`/`ensureLoaded`
    /// reflects what we've actually received via push, not just what
    /// the last `session_list` reported. Without this, after a few
    /// live messages we end up with `store > tentacle` which is
    /// semantically odd (the at-head guard still passes via `>=`
    /// but the divergence makes the logs misleading).
    func observeLiveMessageSeq(_ sessionId: String, seq: Int, kind: String) {
        guard seq > 0 else { return }
        let old = tentacleLastSeq[sessionId] ?? 0
        guard seq > old else { return }
        tentacleLastSeq[sessionId] = seq
        KLog.d("🩹 [2/history bumpTentacle] session=\(sessionId.prefix(12)) lastSeq=\(old)→\(seq) source=push(\(kind))")
    }

    /// True if any **older-page** request is in flight for this
    /// session. Excludes head fetches (those have their own flag) so
    /// the top spinner doesn't flash during open-session's head
    /// request.
    func isLoadingOlder(_ sessionId: String) -> Bool {
        hasSlot(sessionId) { if case .before = $0 { return true }; return false }
    }

    /// True while a DB-first older-history page load is in flight for
    /// this session (`ensureOlderLoadedAsync`). Lets the scroll trigger
    /// serialise continuous loads via single-flight instead of a time
    /// cooldown — the read is async, so this flag is actually held for
    /// the duration (unlike the synchronous legacy path).
    func isLoadingOlderDB(_ sessionId: String) -> Bool {
        loadingOlderDB.contains(sessionId)
    }

    /// True if a head fetch (`requestLatest` / `ensureLoaded`) is in
    /// flight for this session.
    func isLoadingHead(_ sessionId: String) -> Bool {
        hasSlot(sessionId) { if case .head = $0 { return true }; return false }
    }

    /// Read-only access to the last seq we believe tentacle has for
    /// the session (set by `setTentacleInfo` and bumped by
    /// `observeLiveMessageSeq`). Diagnostics-only; production code
    /// should prefer `atHead(_:)`.
    func tentacleLastKnownSeq(_ sessionId: String) -> Int? {
        tentacleLastSeq[sessionId]
    }

    /// True iff the loaded window has walked back to seq 1 — UI
    /// renders "Beginning of conversation" instead of a spinner and
    /// the load-older trigger no-ops.
    func atHistoryStart(_ sessionId: String) -> Bool {
        guard let state = appState?.messageStore.windowState(sessionId) else { return false }
        // bottomSeq=0 means the window is in bootstrap (empty session
        // not yet populated). Don't claim "at history start" there —
        // the user hasn't actually scrolled to anything.
        guard state.bottomSeq > 0 else { return false }
        return state.topSeq <= 1
    }

    /// True when the loaded window's `bottomSeq` reaches the
    /// session's authoritative `lastSeq` per tentacle. UI renders no
    /// bottom spinner. False when tentacleLastSeq isn't known yet
    /// (we don't speculate about head before session_list lands).
    func atHead(_ sessionId: String) -> Bool {
        guard let last = tentacleLastSeq[sessionId], last > 0 else { return false }
        guard let state = appState?.messageStore.windowState(sessionId) else { return false }
        return state.bottomSeq >= last
    }

    // MARK: - Feature-layer façade
    //
    // ChatView, the session list, and the action cards talk to
    // *this* layer for everything message-related. They never reach
    // into MessageStore directly — that keeps the storage internals
    // (window mechanics, DB schema) free to evolve without touching
    // the UI.

    /// Bootstrap the in-memory window for a session and return the
    /// loaded slice. Idempotent — repeated calls during a session's
    /// lifetime are no-ops once the window is already populated.
    @discardableResult
    func openSession(_ sessionId: String, reanchorLatest: Bool = false) -> [ChatMessage] {
        guard let appState else { return [] }
        if reanchorLatest {
            // A Session can be left in history mode after older pagination.
            // Re-entering it must show the authoritative local tail rather than
            // reuse that stale in-memory slice forever while ensureLoaded sees
            // the SQLite DB itself is already at head and correctly sends no
            // network request.
            appState.messageStore.resetWindowToHead(sessionId)
        }
        let loaded = appState.messageStore.loadInitialWindow(sessionId)
        appState.messageStore.restoreCardTurnGate(sessionId, from: loaded)
        let firstSeq = loaded.first?.seq ?? 0
        let lastSeq = loaded.last?.seq ?? 0
        let types = Set(loaded.map(\.type)).sorted().joined(separator: ",")
        KLog.d("📥 [2/history←DB openSession] session=\(sessionId.prefix(12)) loaded=\(loaded.count) seq=[\(firstSeq)…\(lastSeq)] types=[\(types)] source=initialWindow(GRDB)")
        return loaded
    }

    /// Snapshot of the messages currently in memory for the session.
    /// Same shape as `MessageStore.currentWindow` but exposed here so
    /// callers don't take a dependency on MessageStore directly.
    func currentWindow(_ sessionId: String) -> [ChatMessage] {
        appState?.messageStore.currentWindow(sessionId) ?? []
    }

    /// Latest persisted user-side message text for a session.
    func lastUserMessageContent(_ sessionId: String) -> String? {
        appState?.messageStore.lastUserMessageContent(sessionId)
    }

    /// firstSeq of the loaded window — used by the chat view's
    /// "fetch older" trigger to know what `beforeSeq` to ask for.
    /// Returns nil if no window is loaded.
    func windowTopSeq(_ sessionId: String) -> Int? {
        guard let state = appState?.messageStore.windowState(sessionId),
              state.topSeq > 0 else { return nil }
        return state.topSeq
    }

    // MARK: - Request Latest

    /// Load the latest turn (and any prior whole turns that fit in
    /// tentacle's soft cap) for a session. Called by warm-up and by
    /// `ensureLoaded` on session open.
    ///
    /// Sends `request_session_messages(beforeSeq: nil)` — tentacle
    /// anchors at the latest turn and walks backward through earlier
    /// whole turns up to TURN_SOFT_CAP messages. The first batch is
    /// guaranteed to cover the latest turn (the one that ends with
    /// session head), so the consumer never has to scan messages for
    /// a `user_message` sentinel to know "is the latest turn loaded?".
    @discardableResult
    private func requestLatest(sessionId: String, reason: String = "?") -> Bool {
        guard !isLoadingHead(sessionId) else {
            KLog.d("⏳ requestLatest(\(sessionId.prefix(12))): already loading head reason=\(reason)")
            return false
        }
        guard let totalLastSeq = tentacleLastSeq[sessionId], totalLastSeq > 0 else {
            KLog.d("⏭️ requestLatest(\(sessionId.prefix(12))): no tentacleLastSeq reason=\(reason)")
            return false
        }
        guard let appState else { return false }

        let storeLastSeq = appState.messageStore.dbLastSeq(sessionId)
        KLog.d("📩 requestLatest(\(sessionId.prefix(12))): store=\(storeLastSeq) tentacle=\(totalLastSeq) reason=\(reason)")

        // No-op if our cache is already at head — nothing to fetch.
        if storeLastSeq >= totalLastSeq { return false }

        requestFromTentacle(sessionId: sessionId, beforeSeq: nil, reason: reason)
        return true
    }

    /// Idempotent guard for the on-demand path. Called from the chat
    /// view's `onAppear`. If the session is already covered through
    /// head (warm-up did its job, or disk has it), no wire request
    /// happens. Otherwise behaves identically to `requestLatest`.
    func ensureLoaded(sessionId: String, reason: String = "ensureLoaded") {
        guard let appState else { return }

        // We bail only when the id is genuinely unknown to us — firing
        // a head request for a phantom session would just create an
        // orphan response. For sessions present in the digest store
        // we fall through; if `tentacleLastSeq` happens to be missing
        // (e.g. just after `resetSession`, or before the very first
        // `session_list`) an empty DB still warrants a head fetch.
        guard appState.sessionStore.sessions[sessionId] != nil else {
            KLog.d("⏭️ [2/history ensureLoaded] session=\(sessionId.prefix(12)) skip=unknownSession reason=\(reason)")
            return
        }
        guard !isLoadingHead(sessionId) else {
            KLog.d("⏳ [2/history ensureLoaded] session=\(sessionId.prefix(12)) skip=alreadyLoadingHead reason=\(reason)")
            return
        }

        let storeLastSeq = appState.messageStore.dbLastSeq(sessionId)
        let totalLastSeq = tentacleLastSeq[sessionId] ?? 0
        if totalLastSeq > 0 && storeLastSeq >= totalLastSeq {
            KLog.d("✅ [2/history ensureLoaded] session=\(sessionId.prefix(12)) skip=atHead store=\(storeLastSeq) tentacle=\(totalLastSeq) reason=\(reason) — no WS fetch")
            return
        }

        KLog.d("📤 [2/history←WS ensureLoaded] session=\(sessionId.prefix(12)) store=\(storeLastSeq) tentacle=\(totalLastSeq) reason=\(reason) → request head")
        requestFromTentacle(sessionId: sessionId, beforeSeq: nil, reason: reason)
    }

    // MARK: - Warm-up

    /// Active warm-up rule: take the top N sessions by recency, **per
    /// tentacle**. With M tentacles online the worst-case fan-out is
    /// `M × warmupCap` requests. Sized so a typical multi-device setup
    /// (1-2 tentacles online) covers the user's recent working set
    /// without hammering tentacle on session_list.
    ///
    /// We deliberately ignore pinned/active state here — a state bug
    /// (e.g. every session reported as `active`) could otherwise fan
    /// out unbounded `requestLatest` calls and overwhelm tentacle.
    /// The currently-open session is covered separately by
    /// `ensureLoaded(active)` in MessageRouter.handleSessionList.
    private static let warmupCap = 10

    func runWarmup(digests: [SessionDigest]) {
        var recencyById: [String: Date] = [:]
        for digest in digests {
            guard digest.lastSeq > 0 else { continue }
            if let ts = digest.preview?.timestamp, let d = Self.parseISO(ts) {
                recencyById[digest.id] = d
            }
        }

        let eager = digests
            .filter { recencyById[$0.id] != nil }
            .sorted { (a, b) in
                (recencyById[a.id] ?? .distantPast) > (recencyById[b.id] ?? .distantPast)
            }
            .prefix(Self.warmupCap)

        var fired: [String] = []
        var skipped: [String] = []
        for d in eager {
            if requestLatest(sessionId: d.id, reason: "warmup") {
                fired.append(String(d.id.prefix(12)))
            } else {
                skipped.append(String(d.id.prefix(12)))
            }
        }

        let total = recencyById.count
        let dropped = max(0, total - eager.count)
        KLog.chat("🔥 [2/history warm-up] candidates=\(eager.count) fired=\(fired.count) skipAtHeadOrLoading=\(skipped.count) droppedBeyondCap=\(dropped) cap=\(Self.warmupCap) firedSessions=\(fired)")
    }

    private static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    // MARK: - Request Before (Pagination)

    /// Load older messages strictly before `beforeSeq`. Sends
    /// `request_session_messages(beforeSeq: …)`; tentacle returns one
    /// or more whole turns immediately preceding that seq, up to its
    /// soft cap.
    private func requestBefore(sessionId: String, beforeSeq: Int, reason: String = "olderPage") {
        guard let appState else { return }
        guard beforeSeq > 1 else { return }
        guard appState.sessionStore.sessions[sessionId]?.deviceId != nil else { return }

        // Dedupe by the specific beforeSeq, so a gap-bridge call
        // (e.g. beforeSeq=133) and a tail-extend call (e.g.
        // beforeSeq=40) can coexist. A broader per-session "any
        // before in flight" gate lives in `ensureOlderLoaded`
        // (the UX path) — this lower-level guard only protects
        // against literal duplicates of the same beforeSeq.
        if hasSlot(sessionId, where: {
            if case .before(let b) = $0, b == beforeSeq { return true }
            return false
        }) { return }

        // Short-circuit when DB already has the slot immediately
        // below beforeSeq — that means there's no gap to bridge from
        // here. DB is the truth (memory window may not cover that
        // range). The old code asked an in-memory `contains` which
        // missed cases where the row was on disk but outside the
        // current loaded window.
        if appState.messageStore.hasInDB(sessionId, seq: beforeSeq - 1) { return }

        requestFromTentacle(sessionId: sessionId, beforeSeq: beforeSeq, reason: reason)
    }

    /// Number of persistent spine rows in each DB-first page. Page by row count,
    /// never by numeric seq distance: current Tentacle appends a dense spine,
    /// while replay preserves arbitrarily large holes from legacy off-spine rows.
    private static let ensurePageRowLimit = 10

    /// Load one page of older persistent rows, DB-first. A non-empty page is
    /// prepended in spine order; an empty page escalates to WS `requestBefore`.
    ///
    /// Returns `true` when the window grew synchronously (DB hit).
    /// `false` means either we're already at history start, or a WS
    /// request was kicked off and the caller should wait for the
    /// async batch.
    @discardableResult
    func ensureOlderLoaded(sessionId: String) -> Bool {
        guard let appState else { return false }
        guard let state = appState.messageStore.windowState(sessionId),
              state.topSeq > 1, state.bottomSeq > 0 else {
            return false
        }
        let topSeq = state.topSeq
        let page = appState.messageStore.dbMessagesBefore(
            sessionId,
            beforeSeq: topSeq,
            limit: Self.ensurePageRowLimit
        )

        if !page.isEmpty {
            appState.messageStore.prependOlderPage(sessionId, page)
            let newTop = appState.messageStore.windowState(sessionId)?.topSeq ?? topSeq
            KLog.diag("📥 [2/history←DB ensureOlderLoaded] session=\(sessionId.prefix(12)) topSeq=\(topSeq)→\(newTop) source=GRDB count=\(page.count)")
            return true
        }

        // **Second safety** (the UI spinner is the first): when the
        // user scrolls fast and DB is exhausted, ChatView fires
        // `ensureOlderLoaded` repeatedly. Each response advances
        // `topSeq`, so the per-`beforeSeq` dedup in `requestBefore`
        // does NOT catch the spam — every call has a fresh
        // beforeSeq. Coalesce here per-session: if *any* `.before`
        // request is already in flight, drop this call. The pending
        // response will advance topSeq and the next legitimate
        // scroll-driven call can then fetch the next page.
        if hasSlot(sessionId, where: {
            if case .before = $0 { return true }
            return false
        }) {
            KLog.diag("🛑 [2/history debounce] session=\(sessionId.prefix(12)) topSeq=\(topSeq) — ensureOlderLoaded coalesced, .before slot already in flight")
            return false
        }

        KLog.diag("📤 [2/history→WS ensureOlderLoaded] session=\(sessionId.prefix(12)) topSeq=\(topSeq) — DB exhausted, request older")
        requestBefore(sessionId: sessionId, beforeSeq: topSeq, reason: "olderPage")
        return false
    }

    /// Async, off-main-thread version of `ensureOlderLoaded` used by the
    /// chat scroll trigger. The DB read runs on a background queue
    /// (GRDB's `DatabasePool` allows concurrent reads) so a fast flick
    /// never blocks the runloop; the window mutation hops back to the
    /// main actor. A per-session single-flight guard (`loadingOlderDB`)
    /// serialises continuous loads, so the trigger needs no time
    /// cooldown: each completed page lets the next scroll tick fetch
    /// the one above it, riding smoothly toward the start.
    @MainActor
    @discardableResult
    func ensureOlderLoadedAsync(sessionId: String) async -> Bool {
        guard let appState else { return false }
        guard let state = appState.messageStore.windowState(sessionId),
              state.topSeq > 1, state.bottomSeq > 0 else {
            return false
        }
        // Single-flight: the legacy `isLoadingOlder` only tracks WS
        // `.before` slots, which the DB-first path never creates, so it
        // can't gate this. Without this guard a fast flick spawns
        // overlapping reads of the same range.
        guard !loadingOlderDB.contains(sessionId) else { return false }

        let topSeq = state.topSeq

        loadingOlderDB.insert(sessionId)
        defer { loadingOlderDB.remove(sessionId) }
        #if os(macOS)
        KLog.chatEntry(
            "mac-fetch phase=start direction=older session=\(sessionId.prefix(12)) "
                + "window=[\(state.topSeq),\(state.bottomSeq)] "
                + "query=rows-before-\(topSeq) limit=\(Self.ensurePageRowLimit)"
        )
        #endif

        #if DEBUG
        // Isolated Chat performance runs can inject a realistic round-trip so
        // spinner visibility and prepend anchoring are tested over time rather
        // than against an unrealistically instant local SQLite read. This is
        // deliberately unavailable to ordinary production-connected launches.
        let environment = ProcessInfo.processInfo.environment
        let isIsolatedChatTest = environment["KRAKI_MAC_CHAT_PERF_PAGE"] == "1"
            || environment["KRAKI_MAC_CHAT_SNAPSHOT_TEST"] == "1"
        if isIsolatedChatTest,
           let rawDelay = environment["KRAKI_MAC_CHAT_PAGE_DELAY_MS"],
           let delayMs = UInt64(rawDelay), delayMs > 0 {
            try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
        }
        #endif

        // Off-main read. Keeps the scroll/runloop free — the core fix
        // that stops a fast flick from freezing the UI.
        let db = appState.messageStore.db
        let tRead0 = CFAbsoluteTimeGetCurrent()
        let page = await Task.detached(priority: .userInitiated) {
            db.messagesBefore(sessionId, beforeSeq: topSeq, limit: Self.ensurePageRowLimit)
        }.value
        let readMs = (CFAbsoluteTimeGetCurrent() - tRead0) * 1000

        // Re-validate on return to main: a live push or another load may
        // have advanced the window while we were reading. If topSeq
        // drifted, bail; the next scroll-driven trigger recomputes from
        // the new top.
        guard let nowState = appState.messageStore.windowState(sessionId),
              nowState.topSeq == topSeq else {
            #if os(macOS)
            KLog.chatEntry(
                "mac-fetch phase=stale direction=older session=\(sessionId.prefix(12)) "
                    + "requestedTop=\(topSeq) currentTop=\(appState.messageStore.windowState(sessionId)?.topSeq ?? 0)"
            )
            #endif
            return false
        }

        if !page.isEmpty {
            let tExp0 = CFAbsoluteTimeGetCurrent()
            // Current spine rows are dense; replayed legacy rows remain ordered
            // but need not be integer-adjacent because retired transient events
            // consumed the omitted historical seq values.
            appState.messageStore.prependOlderPage(sessionId, page)
            let expMs = (CFAbsoluteTimeGetCurrent() - tExp0) * 1000
            let newTop = appState.messageStore.windowState(sessionId)?.topSeq ?? topSeq
            if newTop < topSeq {
                KLog.diag("📥 [2/history←DB ensureOlderLoadedAsync] session=\(sessionId.prefix(12)) topSeq=\(topSeq)→\(newTop) count=\(page.count) ⏱️read=\(Int(readMs))ms prepend=\(String(format: "%.1f", expMs))ms")
                #if os(macOS)
                let current = appState.messageStore.windowState(sessionId)
                KLog.chatEntry(
                    "mac-fetch phase=applied direction=older session=\(sessionId.prefix(12)) "
                        + "beforeTop=\(topSeq) after=[\(current?.topSeq ?? 0),\(current?.bottomSeq ?? 0)] "
                        + "rows=\(page.count) readMs=\(Int(readMs))"
                )
                #endif
                return true
            }
        }

        // DB exhausted (hole or genuine start) → WS fallback, slot-guarded.
        if hasSlot(sessionId, where: {
            if case .before = $0 { return true }
            return false
        }) {
            KLog.diag("🛑 [2/history debounce] session=\(sessionId.prefix(12)) topSeq=\(topSeq) — ensureOlderLoadedAsync coalesced, .before slot already in flight")
            return false
        }
        KLog.diag("📤 [2/history→WS ensureOlderLoadedAsync] session=\(sessionId.prefix(12)) topSeq=\(topSeq) — DB exhausted, request older")
        #if os(macOS)
        KLog.chatEntry(
            "mac-fetch phase=ws-fallback direction=older session=\(sessionId.prefix(12)) top=\(topSeq)"
        )
        #endif
        requestBefore(sessionId: sessionId, beforeSeq: topSeq, reason: "olderPage")
        return false
    }
    /// the user scrolls back toward the tail and the in-memory window
    /// has been trimmed below `tentacleLastSeq`. DB-first; falls
    /// through to a head WS fetch when the gap can't be filled from
    /// disk.
    @discardableResult
    func ensureNewerLoaded(sessionId: String) -> Bool {
        guard let appState else { return false }
        guard let state = appState.messageStore.windowState(sessionId),
              state.bottomSeq > 0 else {
            return false
        }
        guard let last = tentacleLastSeq[sessionId], state.bottomSeq < last else {
            return false                          // already at head
        }
        let page = appState.messageStore.dbMessagesAfter(
            sessionId,
            afterSeq: state.bottomSeq,
            limit: Self.ensurePageRowLimit
        )

        if !page.isEmpty {
            appState.messageStore.appendNewerPage(sessionId, page)
            let newBottom = appState.messageStore.windowState(sessionId)?.bottomSeq ?? state.bottomSeq
            if newBottom > state.bottomSeq {
                KLog.d("📥 [2/history←DB ensureNewerLoaded] session=\(sessionId.prefix(12)) bottomSeq=\(state.bottomSeq)→\(newBottom) source=GRDB count=\(page.count)")
                return true
            }
        }

        KLog.d("📤 [2/history→WS ensureNewerLoaded] session=\(sessionId.prefix(12)) bottomSeq=\(state.bottomSeq) tentacle=\(last) — DB exhausted, request head")
        ensureLoaded(sessionId: sessionId, reason: "ensureNewerLoaded")
        return false
    }

    /// Discard the current in-memory window and rebuild it from DB's most
    /// recent platform-sized tail. Mirrors the UX "jump to latest" gesture —
    /// an instant snap rather than the per-page extension that
    /// `ensureNewerLoaded` provides.
    /// If DB's tail still trails tentacle's lastSeq, fires a head
    /// fetch so the missing rows arrive shortly after.
    func jumpToHead(sessionId: String) {
        guard let appState else { return }
        appState.messageStore.resetWindowToHead(sessionId)
        let bottom = appState.messageStore.windowState(sessionId)?.bottomSeq ?? 0
        KLog.d("⏬ [2/history jumpToHead] session=\(sessionId.prefix(12)) windowBottom=\(bottom) — reset window to DB tail")
        ensureLoaded(sessionId: sessionId, reason: "jumpToHead")
    }

    // MARK: - Handle Batch

    /// Process a turn-aligned batch from tentacle. Inserts into the
    /// store, clears in-flight tracking, and schedules a gap-bridge
    /// fetch when the batch lands above a non-contiguous DB tail
    /// (common after the user returns to a session that has advanced
    /// while they were away).
    func handleBatch(
        sessionId: String,
        messages: [ChatMessage],
        lastSeq: Int,
        totalLastSeq: Int,
        containsHead: Bool?
    ) {
        guard let appState else { return }

        // Detect a hole between this batch and what we already have
        // on disk. If batch starts at seq B and DB contains B-1 we're
        // contiguous; otherwise the gap [DB max below B + 1 .. B - 1]
        // needs a bridge fetch.
        let batchMinSeq = messages.map(\.seq).min() ?? 0
        let dbLastSeq = appState.messageStore.dbLastSeq(sessionId)
        let hasContiguousBelow: Bool = {
            guard batchMinSeq > 1 else { return true }
            return appState.messageStore.hasInDB(sessionId, seq: batchMinSeq - 1)
        }()

        if !messages.isEmpty {
            appState.messageStore.ingestBatch(sessionId, messages)
            KLog.d("📥 [2/history←DB ingestBatch] session=\(sessionId.prefix(12)) batchSize=\(messages.count) windowSize=\(appState.messageStore.currentWindow(sessionId).count)")
        }

        // Update both history and SessionStore heads. The SessionStore head
        // drives the iOS card's authoritative unread boolean; without this a
        // replay can populate SQLite while the card still shows old cursors.
        let batchHead = max(totalLastSeq, messages.map(\.seq).max() ?? 0)
        if batchHead > (tentacleLastSeq[sessionId] ?? 0) {
            tentacleLastSeq[sessionId] = batchHead
        }
        if batchHead > 0 {
            appState.sessionStore.observeLastSeq(sessionId, seq: batchHead)
        }

        // Identify the exact turn-aligned request answered by this batch.
        // `messages` contains only persistent spine rows, while legacy session
        // logs may have filtered tool/narration seqs near the upper boundary;
        // therefore the final persistent seq can legitimately be several
        // integers below `beforeSeq - 1`.
        let lastPersistentSeq = messages.last?.seq ?? lastSeq
        let removedKind = removeTurnAlignedSlot(
            sessionId,
            containsHead: containsHead,
            lastPersistentSeq: lastPersistentSeq
        )
        if case .before(let requestedBefore) = removedKind,
           appState.messageStore.windowState(sessionId)?.topSeq == requestedBefore {
            appState.messageStore.prependOlderPage(sessionId, messages)
            let newTop = appState.messageStore.windowState(sessionId)?.topSeq ?? requestedBefore
            KLog.diag(
                "📥 [2/history←WS prepend] session=\(sessionId.prefix(12)) "
                    + "topSeq=\(requestedBefore)→\(newTop) count=\(messages.count)"
            )
        }
        let wasHeadRequest: Bool = {
            if case .head = removedKind { return true }
            return false
        }()

        // Did we just land a batch above a pre-existing slice that
        // *isn't* contiguous with it? That means there's a silent
        // hole between [dbLastSeq + 1 .. batchMinSeq - 1]. Common
        // case: user hadn't opened this session for a while; DB
        // stops at some old seq, `requestLatest` anchors at the most
        // recent turn whose start is well above that. Schedule a
        // one-shot bridge fetch ending at batchMinSeq; subsequent
        // batches will re-enter this guard and keep walking the
        // hole closed.
        //
        // Detection: DB has *something* (dbLastSeq > 0) AND its
        // tail is strictly below batchMinSeq - 1 (i.e. not
        // contiguous). The earlier `hasInDB(batchMinSeq - 2)` probe
        // only caught single-message gaps and missed every larger
        // hole — `dbLastSeq` gives us the size-independent answer.
        let needsGapBridge: Bool = {
            guard batchMinSeq > 1 else { return false }
            if hasContiguousBelow { return false }
            return dbLastSeq > 0 && dbLastSeq < batchMinSeq - 1
        }()

        // Only flip the session-wide loading flag off when *no* other
        // head/before request for this session is still pending.
        // `.range` slots don't count — they drive the bottom spinner
        // via `isFillingTail`, not the top spinner.
        let stillLoading = hasSlot(sessionId) { kind in
            if case .head = kind { return true }
            if case .before = kind { return true }
            return false
        }
        if !stillLoading {
            appState.sessionStore.setLoading(sessionId, false)
        }
        _ = wasHeadRequest  // currently informational; kept for clarity

        // Sync follow-up dispatch: we're already on the main queue
        // (WS receive → MessageRouter → MessageProvider), and the
        // bridge call just enqueues another WS send. Doing it
        // synchronously prevents a one-runloop-turn window where
        // setLoading drops to false and the chat view's auto-load can
        // race in to send a duplicate before our follow-up registers.
        if needsGapBridge {
            KLog.d("🪡 detected gap below \(batchMinSeq) in \(sessionId.prefix(12)); bridging via requestBefore(beforeSeq=\(batchMinSeq))")
            requestBefore(sessionId: sessionId, beforeSeq: batchMinSeq)
        }

        // Tail-side recovery: a turn-aligned batch can advance dbLast
        // past seqs we were holding in `pendingTail`, making them
        // committable now. Even if it doesn't, drain is cheap (no I/O
        // for the no-op path) and idempotent.
        drainPendingTail(sessionId)
    }

    // MARK: - Push-Gap Recovery

    /// Single funnel for every live persistent push that
    /// `MessageRouter` previously sent straight to
    /// `messageStore.append`. Buffers the message and runs the drain
    /// loop — anything contiguous with the store's tail commits
    /// immediately; anything that opens a gap waits in the buffer
    /// while we fetch the missing range from tentacle.
    ///
    /// Replaces 13 call sites in `MessageRouter`. The store's
    /// `append` contract changes accordingly: the gap branch is now
    /// a DEBUG assertion (see `MessageStore.append`).
    func ingestTailCandidate(_ sessionId: String, json: Data) {
        guard let msg = ProducerMessageDecoder.decode(json) else { return }
        ingestTailCandidate(sessionId, [msg])
    }

    /// Multi-message overload used by `handleRangeBatch`.
    func ingestTailCandidate(_ sessionId: String, _ messages: [ChatMessage]) {
        guard !messages.isEmpty else { return }

        // Filter to persistent types — non-persistent pushes never
        // belonged in the store anyway and would just clog the buffer.
        let persistent = messages.filter(MessageStore.isPersistent)
        guard !persistent.isEmpty else { return }

        var buf = pendingTail[sessionId] ?? PendingTailBuffer()
        let didOverflow = buf.insertAll(persistent)
        pendingTail[sessionId] = buf
        if didOverflow {
            KLog.d("⚠️ pendingTail[\(sessionId.prefix(12))] exceeded cap=\(PendingTailBuffer.cap) — dropping oldest")
        }
        drainPendingTail(sessionId)
    }

    /// Drain whatever contiguous prefix the buffer can commit now.
    /// Schedules a follow-up `request_session_messages_range` if a
    /// gap remains and no request is already in flight. Idempotent —
    /// safe to call at any time.
    func drainPendingTail(_ sessionId: String) {
        guard let appState else { return }
        guard var buf = pendingTail[sessionId], !buf.isEmpty else { return }

        let dbLast = appState.messageStore.dbLastSeq(sessionId)
        let hasInflight = hasSlot(sessionId) {
            if case .range = $0 { return true }
            return false
        }
        let bufferedBefore = buf.messages.count
        let tombstonesBefore = buf.tombstones.count
        let action = buf.drain(dbLast: dbLast, hasInflight: hasInflight)
        pendingTail[sessionId] = buf

        if !action.toCommit.isEmpty {
            KLog.d("📥 [2/history←pendingTail commit] session=\(sessionId.prefix(12)) count=\(action.toCommit.count) seq=[\(action.toCommit.first!.seq)…\(action.toCommit.last!.seq)] buffered=\(buf.messages.count)")
            appState.messageStore.ingestBatch(sessionId, action.toCommit)
        } else if let head = buf.minSeq {
            // No commit but buffer non-empty → gap detected. Single
            // line that explains why the next `📤 request_range` (if
            // any) is firing, OR why we're stuck waiting on an
            // existing inflight.
            let nextStr = action.nextFetch.map { "[\($0.lowerBound)…\($0.upperBound)]" } ?? "waitingInflight"
            KLog.d("🕳️ [2/history pendingTail gap] session=\(sessionId.prefix(12)) dbLast=\(dbLast) head=\(head) buffered=\(bufferedBefore) tombstones=\(tombstonesBefore) → \(nextStr)")
        }

        if let range = action.nextFetch {
            triggerRangeFetch(sessionId: sessionId, range: range)
        }

        // Buffer fully drained — clean up the dict entry so
        // `isFillingTail` flips false.
        let stillHasRange = hasSlot(sessionId) {
            if case .range = $0 { return true }
            return false
        }
        if buf.isEmpty && !stillHasRange {
            pendingTail.removeValue(forKey: sessionId)
        }
    }

    /// Fire a `request_session_messages_range` for the given gap.
    /// Records the inflight range slot, arms a timeout so a silently
    /// dropped response can never strand the session.
    private func triggerRangeFetch(sessionId: String, range: ClosedRange<Int>) {
        guard let appState else { return }
        guard let deviceId = appState.sessionStore.sessions[sessionId]?.deviceId,
              !deviceId.isEmpty else {
            // No device yet — we'll get another chance the next time
            // setTentacleInfo fires (which also re-drains).
            KLog.d("⏭️ rangeFetch \(sessionId.prefix(12)) skip=noDevice range=\(range.lowerBound)..\(range.upperBound)")
            return
        }
        // Defensive: by construction the upper bound is `buffer.first.seq - 1`
        // which is always >= dbLast + 1, so the range is non-empty.
        guard range.lowerBound <= range.upperBound else { return }

        // Range cardinality invariant: at most one `.range` slot per
        // session. PendingTailBuffer's drain loop respects this via
        // the `hasInflight` parameter, but assert for the future
        // refactor that breaks it.
        assert(!hasSlot(sessionId) { if case .range = $0 { return true }; return false },
               "triggerRangeFetch invariant: at most one .range slot per session")

        KLog.d("📤 [2/history→WS request_range] session=\(sessionId.prefix(12)) range=[\(range.lowerBound)…\(range.upperBound)] device=\(deviceId.prefix(12))")

        let task = DispatchWorkItem { [weak self] in
            guard let self else { return }
            KLog.d("⏰ range fetch [\(range.lowerBound)…\(range.upperBound)] for \(sessionId.prefix(12)) timed out, retrying")
            self.removeFirstSlot(sessionId) {
                if case .range(let r) = $0, r == range { return true }
                return false
            }
            self.drainPendingTail(sessionId)
        }
        addSlot(sessionId, RequestSlot(kind: .range(range), timeout: task))
        appState.commandSender?.requestSessionMessagesRange(
            sessionId: sessionId,
            fromSeq: range.lowerBound,
            toSeq: range.upperBound
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: task)
    }

    /// Process a `session_messages_range_batch` envelope from
    /// tentacle. Records what the server told us about the requested
    /// range (tombstoning confirmed-empty seqs), inserts the returned
    /// messages, then re-drains.
    func handleRangeBatch(
        sessionId: String,
        messages: [ChatMessage],
        firstSeq: Int,
        lastSeq: Int,
        truncated: Bool
    ) {
        let types = Set(messages.map(\.type)).sorted().joined(separator: ",")

        // Clear the inflight range slot for this session (at most
        // one outstanding request by construction).
        var requested: ClosedRange<Int>?
        if case .range(let r) = removeFirstSlot(sessionId, where: {
            if case .range = $0 { return true }
            return false
        }) {
            requested = r
        }
        guard let requested else {
            // No matching request — most likely a stale response after
            // a tentacle reconnect. Drop it; the next drain will
            // re-trigger if needed.
            KLog.d("🤷 range_batch for \(sessionId.prefix(12)) with no matching inflight — ignoring count=\(messages.count) seq=[\(firstSeq)…\(lastSeq)]")
            return
        }

        var buf = pendingTail[sessionId] ?? PendingTailBuffer()
        let tombstonesBefore = buf.tombstones.count
        let didOverflow = buf.ingestRangeResponse(
            messages: messages.filter(MessageStore.isPersistent),
            requestedFrom: requested.lowerBound,
            requestedTo: requested.upperBound,
            responseFirstSeq: firstSeq,
            responseLastSeq: lastSeq,
            truncated: truncated
        )
        let tombstonesAdded = buf.tombstones.count - tombstonesBefore
        pendingTail[sessionId] = buf

        KLog.d("📦 [2/history←WS range_batch] session=\(sessionId.prefix(12)) requested=[\(requested.lowerBound)…\(requested.upperBound)] response=[\(firstSeq)…\(lastSeq)] count=\(messages.count) tombstonesAdded=\(tombstonesAdded) truncated=\(truncated) types=[\(types)]")

        if didOverflow {
            KLog.d("⚠️ pendingTail[\(sessionId.prefix(12))] exceeded cap on range_batch")
        }

        drainPendingTail(sessionId)
    }

    /// Whether the chat tail is currently being filled in the
    /// background. UI binds a bottom spinner to this. True iff the
    /// buffer has unresolved entries (waiting on a range fetch) or
    /// a request is in flight.
    func isFillingTail(_ sessionId: String) -> Bool {
        if hasSlot(sessionId, where: { if case .range = $0 { return true }; return false }) {
            return true
        }
        if let buf = pendingTail[sessionId], !buf.isEmpty { return true }
        return false
    }

    // MARK: - Preview

    // MARK: - Private

    private func requestFromTentacle(sessionId: String, beforeSeq: Int?, reason: String = "?") {
        guard let appState else { return }
        guard let tentacleDeviceId = appState.sessionStore.sessions[sessionId]?.deviceId,
              !tentacleDeviceId.isEmpty else { return }

        let slotKind: OutstandingKind = beforeSeq.map { .before($0) } ?? .head
        let kind = beforeSeq == nil ? "head" : "before=\(beforeSeq!)"
        KLog.d("📤 [2/history→WS request_session_messages] session=\(sessionId.prefix(12)) kind=\(kind) reason=\(reason) tentacle=\(tentacleDeviceId.prefix(12))")
        appState.sessionStore.setLoading(sessionId, true)

        // Safety timeout — if no batch arrives within the window we
        // mark the session as load-failed so the UI can show a
        // retry affordance instead of leaving an empty/stale view.
        // Captures slotKind so it removes exactly the slot it added.
        let work = DispatchWorkItem { [weak self, weak appState] in
            self?.removeFirstSlot(sessionId) { $0 == slotKind }
            KLog.d("⏱ session messages timeout — session=\(sessionId.prefix(12)) kind=\(kind)")
            appState?.sessionStore.markLoadFailed(sessionId)
        }
        addSlot(sessionId, RequestSlot(kind: slotKind, timeout: work))

        appState.commandSender?.requestSessionMessages(
            sessionId: sessionId,
            beforeSeq: beforeSeq
        )

        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    // MARK: - Trace + card (ephemeral pass-through)

    /// Pull one turn's TRACE steps for the "Steps" popup (deduped). The reply
    /// (`turn_trace_batch`) lands in `handleTurnTraceBatch`.
    func requestTurnTrace(sessionId: String, bubbleSeq: Int) {
        guard bubbleSeq > 0 else { return }
        let key = "\(sessionId):\(bubbleSeq)"
        guard !tracePulled.contains(key) else { return }
        guard appState?.sessionStore.sessions[sessionId]?.deviceId != nil else { return }
        tracePulled.insert(key)
        appState?.commandSender?.requestTurnTrace(sessionId: sessionId, bubbleSeq: bubbleSeq)
    }

    /// Force a re-pull of a turn's trace on the next request (e.g. a live turn).
    func invalidateTurnTrace(sessionId: String, bubbleSeq: Int) {
        tracePulled.remove("\(sessionId):\(bubbleSeq)")
    }

    /// Inject a pulled trace into the store. A still-running turn
    /// (`complete == false`) is left re-pullable so idle can reconcile.
    func handleTurnTraceBatch(sessionId: String, bubbleSeq: Int, entries: [ChatMessage], complete: Bool) {
        appState?.messageStore.setTurnSteps(sessionId, bubbleSeq: bubbleSeq, entries)
        if !complete { tracePulled.remove("\(sessionId):\(bubbleSeq)") }
    }

    /// On idle: find the just-concluded bubble (agent_message / system_message)
    /// and pull its authoritative trace once.
    func pullLatestTurnTrace(_ sessionId: String) {
        guard let appState else { return }
        for m in appState.messageStore.recentFromDB(sessionId, limit: 30).reversed() {
            if m.type == "agent_message" || m.type == "system_message" {
                invalidateTurnTrace(sessionId: sessionId, bubbleSeq: m.seq)
                requestTurnTrace(sessionId: sessionId, bubbleSeq: m.seq)
                return
            }
            if m.type == "user_message" { return }
        }
    }

    /// Ask for the live card snapshot on open/reconnect of a non-idle session.
    func requestCard(_ sessionId: String, force: Bool = false) {
        if force { cardRequested.remove(sessionId) }
        guard !cardRequested.contains(sessionId) else { return }
        guard appState?.sessionStore.sessions[sessionId]?.deviceId != nil else { return }
        cardRequested.insert(sessionId)
        appState?.commandSender?.requestCard(sessionId: sessionId)
    }

    #if DEBUG
    /// Seed representative connection-scoped requests without sending network
    /// traffic. Used by the native disconnect regression.
    func debugSeedDisconnectRegressionState(_ sessionId: String) {
        let makeSlot: (OutstandingKind) -> RequestSlot = { kind in
            RequestSlot(kind: kind, timeout: DispatchWorkItem {})
        }
        addSlot(sessionId, makeSlot(.head))
        addSlot(sessionId, makeSlot(.before(42)))
        addSlot(sessionId, makeSlot(.range(43...44)))
        tentacleLastSeq[sessionId] = 99
        appState?.sessionStore.setLoading(sessionId, true)
    }
    #endif

    // MARK: - Cleanup

    /// Drop every connection-scoped request when the WebSocket closes.
    /// Responses for these slots can no longer arrive on the old socket; keeping
    /// them until their 10-second timeout blocks the post-reconnect
    /// `sessionListSelfHeal` request and strands Chat behind a loading spinner.
    /// Persisted messages and the current in-memory window remain untouched, so
    /// the UI can keep presenting local history while the new connection forms.
    func onDisconnected() {
        let slotCount = outstanding.values.reduce(0) { $0 + $1.count }
        for (_, slots) in outstanding {
            for slot in slots { slot.timeout.cancel() }
        }
        outstanding.removeAll()
        tentacleLastSeq.removeAll()
        pendingTail.removeAll()
        tracePulled.removeAll()
        cardRequested.removeAll()
        appState?.sessionStore.loadingSessions.removeAll()
        KLog.chat("🧹 [2/history disconnect] clearedSlots=\(slotCount) preservedWindows=1")
    }

    func clear() {
        for (_, slots) in outstanding {
            for s in slots { s.timeout.cancel() }
        }
        outstanding.removeAll()
        tentacleLastSeq.removeAll()
        pendingTail.removeAll()
        tracePulled.removeAll()
        cardRequested.removeAll()
        appState?.sessionStore.loadingSessions.removeAll()
    }

    /// Reset all in-memory provider state for a single session. Used
    /// by the test page's "Wipe DB" path so post-wipe `ensureLoaded`
    /// fetches against an empty DB without any stale inflight slot
    /// or pendingTail buffer in the way.
    ///
    /// Does NOT touch DB rows (caller owns that), the store window
    /// (caller calls `MessageStore.unload`), or the session_list
    /// `tentacleLastSeq` — keeping the latter avoids a 0.5s window
    /// where post-wipe `ensureLoaded` would have nothing to compare
    /// against until the next `session_list` envelope arrives.
    func resetSession(_ sessionId: String) {
        if let slots = outstanding[sessionId] {
            for s in slots { s.timeout.cancel() }
        }
        outstanding.removeValue(forKey: sessionId)
        pendingTail.removeValue(forKey: sessionId)
        tracePulled = tracePulled.filter { !$0.hasPrefix("\(sessionId):") }
        cardRequested.remove(sessionId)
        appState?.sessionStore.setLoading(sessionId, false)
    }
}
