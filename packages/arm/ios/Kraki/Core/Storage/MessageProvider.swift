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
    private static let previewMaxLength = 80

    /// In-flight requests keyed by "sessionId:afterSeq".
    private var inFlightRequests: Set<String> = []

    /// Per-session highest known seq on the tentacle (from session_list).
    private var tentacleLastSeq: [String: Int] = [:]

    /// Per-session tentacle device ID.
    private var tentacleDeviceMap: [String: String] = [:]

    /// Per-session push-gap recovery buffer. Pure data — all the
    /// network I/O and timeout machinery lives in this provider; the
    /// buffer just decides what to commit and what to fetch next.
    /// See `PendingTailBuffer` for the algorithm.
    private var pendingTail: [String: PendingTailBuffer] = [:]

    /// Per-session in-flight range request, or nil. At most one
    /// outstanding `request_session_messages_range` per session keeps
    /// the wire traffic predictable and lets the drain loop assume
    /// linear progress.
    private var inflightRange: [String: ClosedRange<Int>] = [:]

    /// Safety timeout handles for the in-flight range requests. Keyed
    /// by sessionId — there's at most one per session by construction.
    private var rangeTimeoutTasks: [String: DispatchWorkItem] = [:]

    /// Sessions whose latest in-flight request asked for the head
    /// (beforeSeq=nil). Used by `handleBatch` to identify which
    /// in-flight key to clear (head responses land on "sessionId:head"
    /// rather than "sessionId:lastSeq+1").
    private var pendingHeadRequests: Set<String> = []

    /// Safety timeout handles.
    private var timeoutTasks: [String: DispatchWorkItem] = [:]

    private weak var appState: AppState?

    init(appState: AppState) {
        self.appState = appState
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
        tentacleDeviceMap[sessionId] = deviceId
        if let oldLastSeq, oldLastSeq != lastSeq {
            KLog.chat("🏷️ [2/history setTentacleInfo] session=\(sessionId.prefix(12)) lastSeq=\(oldLastSeq)→\(lastSeq) device=\(deviceId.prefix(12))")
        } else if oldLastSeq == nil {
            KLog.chat("🏷️ [2/history setTentacleInfo] session=\(sessionId.prefix(12)) lastSeq=nil→\(lastSeq) device=\(deviceId.prefix(12))")
        }

        // Reset in-flight range tracking on every session_list. Reasons:
        //   1. After a WS reconnect, any previously-pending range
        //      request will never get a response — we must clear
        //      `inflightRange` so the drain loop can re-trigger.
        //   2. The tentacle deviceId may have changed (rare but
        //      possible if the tentacle restarted under a new
        //      identity). Anything already in flight was addressed
        //      to a stale device.
        // Then re-drain in case pendingTail has content that's
        // waiting on a fresh fetch.
        inflightRange.removeValue(forKey: sessionId)
        rangeTimeoutTasks[sessionId]?.cancel()
        rangeTimeoutTasks.removeValue(forKey: sessionId)
        if !(pendingTail[sessionId]?.isEmpty ?? true) {
            drainPendingTail(sessionId)
        }
    }

    /// Live-message observer: called from `MessageRouter` every time
    /// a persistent push message lands (user_message, agent_message,
    /// tool_complete, etc.). Bumps `tentacleLastSeq` up to the new
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
        KLog.chat("🩹 [2/history bumpTentacle] session=\(sessionId.prefix(12)) lastSeq=\(old)→\(seq) source=push(\(kind))")
    }

    /// Check if any request is in flight for a session.
    func isLoading(_ sessionId: String) -> Bool {
        inFlightRequests.contains { $0.hasPrefix("\(sessionId):") }
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
    func openSession(_ sessionId: String) -> [ChatMessage] {
        guard let appState else { return [] }
        let loaded = appState.messageStore.loadInitialWindow(sessionId)
        let firstSeq = loaded.first?.seq ?? 0
        let lastSeq = loaded.last?.seq ?? 0
        let types = Set(loaded.map(\.type)).sorted().joined(separator: ",")
        KLog.chat("📥 [2/history←DB openSession] session=\(sessionId.prefix(12)) loaded=\(loaded.count) seq=[\(firstSeq)…\(lastSeq)] types=[\(types)] source=initialWindow(GRDB)")
        return loaded
    }

    /// Snapshot of the messages currently in memory for the session.
    /// Same shape as `MessageStore.currentWindow` but exposed here so
    /// callers don't take a dependency on MessageStore directly.
    func currentWindow(_ sessionId: String) -> [ChatMessage] {
        appState?.messageStore.currentWindow(sessionId) ?? []
    }

    /// Latest persisted agent_message text for a session, regardless
    /// of window state. Used by the session list's "current activity"
    /// row.
    func lastAgentMessageContent(_ sessionId: String) -> String? {
        appState?.messageStore.lastAgentMessageContent(sessionId)
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
    func requestLatest(sessionId: String, reason: String = "?") -> Bool {
        guard !isLoading(sessionId) else {
            KLog.d("⏳ requestLatest(\(sessionId.prefix(12))): already loading reason=\(reason)")
            return false
        }
        guard let totalLastSeq = tentacleLastSeq[sessionId], totalLastSeq > 0 else {
            KLog.d("⏭️ requestLatest(\(sessionId.prefix(12))): no tentacleLastSeq reason=\(reason)")
            return false
        }
        guard let appState else { return false }

        let storeLastSeq = appState.messageStore.dbLastSeq(sessionId)
        KLog.d("📩 requestLatest(\(sessionId.prefix(12))): store=\(storeLastSeq) tentacle=\(totalLastSeq) reason=\(reason)")

        if storeLastSeq > 0 {
            rebuildPreview(sessionId: sessionId)
        }

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
        guard let totalLastSeq = tentacleLastSeq[sessionId], totalLastSeq > 0 else {
            KLog.chat("⏭️ [2/history ensureLoaded] session=\(sessionId.prefix(12)) skip=noTentacleLastSeq reason=\(reason)")
            return
        }
        guard !isLoading(sessionId) else {
            KLog.chat("⏳ [2/history ensureLoaded] session=\(sessionId.prefix(12)) skip=alreadyLoading reason=\(reason)")
            return
        }
        guard let appState else { return }

        let storeLastSeq = appState.messageStore.dbLastSeq(sessionId)
        if storeLastSeq >= totalLastSeq {
            KLog.chat("✅ [2/history ensureLoaded] session=\(sessionId.prefix(12)) skip=atHead store=\(storeLastSeq) tentacle=\(totalLastSeq) reason=\(reason) — no WS fetch")
            return
        }

        KLog.chat("📤 [2/history←WS ensureLoaded] session=\(sessionId.prefix(12)) store=\(storeLastSeq) tentacle=\(totalLastSeq) reason=\(reason) → request head")
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
    func requestBefore(sessionId: String, beforeSeq: Int, reason: String = "olderPage") {
        guard let appState else { return }
        guard beforeSeq > 1 else { return }
        guard tentacleDeviceMap[sessionId] != nil else { return }

        // Dedupe by the specific beforeSeq, not by sessionId, so a
        // gap-bridge call (e.g. beforeSeq=133) and a tail-extend call
        // (e.g. beforeSeq=40) can coexist. The previous broad
        // "anything in flight" check made the gap bridge lose every
        // race against the chat view's top-spinner auto-load.
        let loadKey = "\(sessionId):\(beforeSeq)"
        if inFlightRequests.contains(loadKey) { return }

        // Short-circuit when DB already has the slot immediately
        // below beforeSeq — that means there's no gap to bridge from
        // here. DB is the truth (memory window may not cover that
        // range). The old code asked an in-memory `contains` which
        // missed cases where the row was on disk but outside the
        // current loaded window.
        if appState.messageStore.hasInDB(sessionId, seq: beforeSeq - 1) { return }

        requestFromTentacle(sessionId: sessionId, beforeSeq: beforeSeq, reason: reason)
    }

    /// Unified "I need older messages" entry point used by the chat
    /// view's top-spinner auto-load. If anything older than
    /// `beforeSeq` is already on disk (whether in the window or
    /// not), no wire request — the window-load path can grow the
    /// window from DB. Otherwise falls through to `requestBefore`.
    @discardableResult
    func ensureOlderLoaded(sessionId: String, beforeSeq: Int) -> Bool {
        guard let appState else { return false }
        guard beforeSeq > 1 else { return false }
        // Already in DB: ChatView's window-load path can satisfy
        // the request without a network round-trip.
        let dbLast = appState.messageStore.dbLastSeq(sessionId)
        // Cheap heuristic: if our DB's lowest seq for this session
        // is < beforeSeq we have *something* older. dbLastSeq gives
        // us only the max, so use `hasInDB(beforeSeq - 1)` as the
        // direct check.
        if appState.messageStore.hasInDB(sessionId, seq: beforeSeq - 1) {
            KLog.chat("📥 [2/history←DB ensureOlderLoaded] session=\(sessionId.prefix(12)) beforeSeq=\(beforeSeq) source=GRDB (no WS)")
            return false
        }
        _ = dbLast
        // Not in DB → fetch.
        let wasInFlight = inFlightRequests.contains("\(sessionId):\(beforeSeq)")
        KLog.chat("📤 [2/history←WS ensureOlderLoaded] session=\(sessionId.prefix(12)) beforeSeq=\(beforeSeq) inFlight=\(wasInFlight) → request older")
        requestBefore(sessionId: sessionId, beforeSeq: beforeSeq, reason: "olderPage")
        return !wasInFlight
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
        totalLastSeq: Int
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
            KLog.chat("📥 [2/history←DB ingestBatch] session=\(sessionId.prefix(12)) batchSize=\(messages.count) windowSize=\(appState.messageStore.currentWindow(sessionId).count)")
            rebuildPreview(sessionId: sessionId)
        }

        // Update tentacle last seq if server reports higher
        if totalLastSeq > (tentacleLastSeq[sessionId] ?? 0) {
            tentacleLastSeq[sessionId] = totalLastSeq
        }

        let wasHeadRequest = pendingHeadRequests.remove(sessionId) != nil

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

        // Clear in-flight tracking for the *specific* request this
        // batch answers — not every in-flight key for the session.
        // requestBefore now dedupes by (sessionId, beforeSeq), so a
        // sibling page-older request can be in flight at the same
        // time as a head fetch and must not be evicted just because
        // the head batch landed.
        //
        // Identification heuristic:
        //   - Head request response → "sessionId:head"
        //   - "before X" request response → "sessionId:(lastSeq+1)"
        //   (tentacle's response to beforeSeq=X always has lastSeq=X-1)
        let respondingKey = wasHeadRequest
            ? "\(sessionId):head"
            : "\(sessionId):\(lastSeq + 1)"
        if inFlightRequests.remove(respondingKey) != nil {
            timeoutTasks[respondingKey]?.cancel()
            timeoutTasks.removeValue(forKey: respondingKey)
        }
        // Only flip the session-wide loading flag off when *no* other
        // request for this session is still pending. Otherwise the
        // top-spinner / center-spinner would briefly flicker even
        // though a sibling fetch is still resolving.
        let stillLoading = inFlightRequests.contains { $0.hasPrefix("\(sessionId):") }
        if !stillLoading {
            appState.sessionStore.setLoading(sessionId, false)
        }

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
        let hasInflight = inflightRange[sessionId] != nil
        let bufferedBefore = buf.messages.count
        let tombstonesBefore = buf.tombstones.count
        let action = buf.drain(dbLast: dbLast, hasInflight: hasInflight)
        pendingTail[sessionId] = buf

        if !action.toCommit.isEmpty {
            KLog.chat("📥 [2/history←pendingTail commit] session=\(sessionId.prefix(12)) count=\(action.toCommit.count) seq=[\(action.toCommit.first!.seq)…\(action.toCommit.last!.seq)] buffered=\(buf.messages.count)")
            appState.messageStore.ingestBatch(sessionId, action.toCommit)
            rebuildPreview(sessionId: sessionId)
        } else if let head = buf.minSeq {
            // No commit but buffer non-empty → gap detected. Single
            // line that explains why the next `📤 request_range` (if
            // any) is firing, OR why we're stuck waiting on an
            // existing inflight.
            let nextStr = action.nextFetch.map { "[\($0.lowerBound)…\($0.upperBound)]" } ?? "waitingInflight"
            KLog.chat("🕳️ [2/history pendingTail gap] session=\(sessionId.prefix(12)) dbLast=\(dbLast) head=\(head) buffered=\(bufferedBefore) tombstones=\(tombstonesBefore) → \(nextStr)")
        }

        if let range = action.nextFetch {
            triggerRangeFetch(sessionId: sessionId, range: range)
        }

        // Buffer fully drained — clean up the dict entry so
        // `isFillingTail` flips false.
        if buf.isEmpty && inflightRange[sessionId] == nil {
            pendingTail.removeValue(forKey: sessionId)
        }
    }

    /// Fire a `request_session_messages_range` for the given gap.
    /// Records the inflight range, arms a timeout so a silently
    /// dropped response can never strand the session.
    private func triggerRangeFetch(sessionId: String, range: ClosedRange<Int>) {
        guard let appState else { return }
        guard let deviceId = tentacleDeviceMap[sessionId] else {
            // No device yet — we'll get another chance the next time
            // setTentacleInfo fires (which also re-drains).
            KLog.d("⏭️ rangeFetch \(sessionId.prefix(12)) skip=noDevice range=\(range.lowerBound)..\(range.upperBound)")
            return
        }
        // Defensive: by construction the upper bound is `buffer.first.seq - 1`
        // which is always >= dbLast + 1, so the range is non-empty.
        guard range.lowerBound <= range.upperBound else { return }

        KLog.chat("📤 [2/history→WS request_range] session=\(sessionId.prefix(12)) range=[\(range.lowerBound)…\(range.upperBound)] device=\(deviceId.prefix(12))")
        inflightRange[sessionId] = range
        appState.commandSender?.requestSessionMessagesRange(
            sessionId: sessionId,
            fromSeq: range.lowerBound,
            toSeq: range.upperBound
        )

        // Safety timeout — if no batch arrives within 10s, clear the
        // inflight slot and let drain re-trigger.
        let task = DispatchWorkItem { [weak self] in
            guard let self else { return }
            KLog.d("⏰ range fetch [\(range.lowerBound)…\(range.upperBound)] for \(sessionId.prefix(12)) timed out, retrying")
            self.inflightRange.removeValue(forKey: sessionId)
            self.rangeTimeoutTasks.removeValue(forKey: sessionId)
            self.drainPendingTail(sessionId)
        }
        rangeTimeoutTasks[sessionId] = task
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

        // Clear the inflight tracking and timeout for this session
        // (at most one outstanding request by construction).
        guard let requested = inflightRange.removeValue(forKey: sessionId) else {
            // No matching request — most likely a stale response after
            // a tentacle reconnect. Drop it; the next drain will
            // re-trigger if needed.
            KLog.d("🤷 range_batch for \(sessionId.prefix(12)) with no matching inflight — ignoring count=\(messages.count) seq=[\(firstSeq)…\(lastSeq)]")
            return
        }
        rangeTimeoutTasks[sessionId]?.cancel()
        rangeTimeoutTasks.removeValue(forKey: sessionId)

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

        KLog.chat("📦 [2/history←WS range_batch] session=\(sessionId.prefix(12)) requested=[\(requested.lowerBound)…\(requested.upperBound)] response=[\(firstSeq)…\(lastSeq)] count=\(messages.count) tombstonesAdded=\(tombstonesAdded) truncated=\(truncated) types=[\(types)]")

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
        if inflightRange[sessionId] != nil { return true }
        if let buf = pendingTail[sessionId], !buf.isEmpty { return true }
        return false
    }

    // MARK: - Preview

    /// Recompute session preview from the persisted message stream.
    /// Reads the tail of the DB (independent of the in-memory window
    /// state) so the sidebar shows the real last meaningful message
    /// even when the user is scrolled into history. Scans backwards
    /// for the first message that matches one of the preview-worthy
    /// types.
    ///
    /// Forked / freshly-imported sessions need their fork timestamp
    /// preserved so they sort next to other freshly-touched sessions
    /// instead of next to their parent's old last-message — detect by
    /// comparing the existing preview's timestamp to the new one and
    /// keep the newer.
    func rebuildPreview(sessionId: String) {
        guard let appState else { return }
        let msgs = appState.messageStore.recentFromDB(sessionId, limit: 30)
        guard !msgs.isEmpty else { return }

        let existing = appState.sessionStore.sessionPreviews[sessionId]

        func write(text: String, type: String, timestamp: String) {
            let chosenTs: String = {
                guard let e = existing,
                      let existingDate = Self.parseISO(e.timestamp),
                      let newDate = Self.parseISO(timestamp),
                      existingDate > newDate else { return timestamp }
                return e.timestamp
            }()
            appState.sessionStore.setPreview(
                sessionId,
                text: String(text.prefix(Self.previewMaxLength)),
                type: type,
                timestamp: chosenTs
            )
        }

        for i in stride(from: msgs.count - 1, through: 0, by: -1) {
            let m = msgs[i]

            switch m.type {
            case "question":
                write(text: m.question ?? "", type: "question", timestamp: m.timestamp ?? "")
                return
            case "permission":
                write(text: m.toolName ?? "", type: "permission", timestamp: m.timestamp ?? "")
                return
            case "error":
                write(text: m.errorMessage ?? "Error", type: "error", timestamp: m.timestamp ?? "")
                return
            case "user_message":
                write(text: m.content ?? "", type: "user", timestamp: m.timestamp ?? "")
                return
            case "answer":
                let answer = m.answer ?? ""
                if !answer.isEmpty {
                    write(text: answer, type: "answer", timestamp: m.timestamp ?? "")
                    return
                }
            case "agent_message":
                let content = m.content ?? ""
                let next = i + 1 < msgs.count ? msgs[i + 1] : nil
                if next == nil || next?.type == "idle" {
                    write(text: content, type: "agent", timestamp: m.timestamp ?? "")
                    return
                }
            default:
                continue
            }
        }
    }

    // MARK: - Private

    private func requestFromTentacle(sessionId: String, beforeSeq: Int?, reason: String = "?") {
        guard let tentacleDeviceId = tentacleDeviceMap[sessionId] else { return }
        guard let appState else { return }

        // Use beforeSeq as the dedupe key so head-fetches (nil → "head")
        // don't collide with paginated older-fetches.
        let loadKey = "\(sessionId):\(beforeSeq.map(String.init) ?? "head")"
        let kind = beforeSeq == nil ? "head" : "before=\(beforeSeq!)"
        KLog.chat("📤 [2/history→WS request_session_messages] session=\(sessionId.prefix(12)) kind=\(kind) reason=\(reason) tentacle=\(tentacleDeviceId.prefix(12))")
        inFlightRequests.insert(loadKey)
        if beforeSeq == nil { pendingHeadRequests.insert(sessionId) }
        appState.sessionStore.setLoading(sessionId, true)

        appState.commandSender?.requestSessionMessages(
            sessionId: sessionId,
            beforeSeq: beforeSeq
        )

        // Safety timeout — if no batch arrives within the window we
        // mark the session as load-failed so the UI can show a
        // retry affordance instead of leaving an empty/stale view.
        let work = DispatchWorkItem { [weak self, weak appState] in
            self?.inFlightRequests.remove(loadKey)
            self?.pendingHeadRequests.remove(sessionId)
            KLog.d("⏱ session messages timeout — \(loadKey)")
            appState?.sessionStore.markLoadFailed(sessionId)
        }
        timeoutTasks[loadKey] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    // MARK: - Cleanup

    func clear() {
        inFlightRequests.removeAll()
        pendingHeadRequests.removeAll()
        tentacleLastSeq.removeAll()
        tentacleDeviceMap.removeAll()
        for (_, work) in timeoutTasks { work.cancel() }
        timeoutTasks.removeAll()
        pendingTail.removeAll()
        inflightRange.removeAll()
        for (_, work) in rangeTimeoutTasks { work.cancel() }
        rangeTimeoutTasks.removeAll()
        appState?.sessionStore.loadingSessions.removeAll()
    }
}
