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

    /// Sessions whose latest in-flight request asked for the head
    /// (beforeSeq=nil). Used by `handleBatch` to decide whether to
    /// schedule a follow-up requestLatest when `containsHead=false`.
    private var pendingHeadRequests: Set<String> = []

    /// Safety timeout handles.
    private var timeoutTasks: [String: DispatchWorkItem] = [:]

    private weak var appState: AppState?

    init(appState: AppState) {
        self.appState = appState
    }

    // MARK: - Configuration

    /// Update tentacle metadata from session_list.
    func setTentacleInfo(sessionId: String, lastSeq: Int, deviceId: String) {
        tentacleLastSeq[sessionId] = lastSeq
        tentacleDeviceMap[sessionId] = deviceId
    }

    /// Check if any request is in flight for a session.
    func isLoading(_ sessionId: String) -> Bool {
        inFlightRequests.contains { $0.hasPrefix("\(sessionId):") }
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
    func requestLatest(sessionId: String) {
        guard !isLoading(sessionId) else {
            KLog.d("⏳ requestLatest(\(sessionId.prefix(12))): already loading")
            return
        }
        guard let totalLastSeq = tentacleLastSeq[sessionId], totalLastSeq > 0 else {
            KLog.d("⏭️ requestLatest(\(sessionId.prefix(12))): no tentacleLastSeq")
            return
        }
        guard let appState else { return }

        // Pull in any persisted history first so getLastSeq reflects
        // the cache, not just whatever happens to be in memory.
        appState.messageStore.hydrateFromDisk(sessionId)
        let storeLastSeq = appState.messageStore.getLastSeq(sessionId)
        KLog.d("📩 requestLatest(\(sessionId.prefix(12))): store=\(storeLastSeq) tentacle=\(totalLastSeq)")

        if storeLastSeq > 0 {
            rebuildPreview(sessionId: sessionId)
        }

        // No-op if our cache is already at head — nothing to fetch.
        if storeLastSeq >= totalLastSeq { return }

        requestFromTentacle(sessionId: sessionId, beforeSeq: nil)
    }

    /// Idempotent guard for the on-demand path. Called from the chat
    /// view's `onAppear`. If the session is already covered through
    /// head (warm-up did its job, or disk has it), no wire request
    /// happens. Otherwise behaves identically to `requestLatest`.
    func ensureLoaded(sessionId: String) {
        guard let totalLastSeq = tentacleLastSeq[sessionId], totalLastSeq > 0 else { return }
        guard !isLoading(sessionId) else { return }
        guard let appState else { return }

        appState.messageStore.hydrateFromDisk(sessionId)
        let storeLastSeq = appState.messageStore.getLastSeq(sessionId)
        if storeLastSeq >= totalLastSeq { return }

        requestFromTentacle(sessionId: sessionId, beforeSeq: nil)
    }

    // MARK: - Warm-up

    /// Active warm-up rule:
    ///   - Always warm `active` and `pinned` sessions (no cap).
    ///   - Plus the top 5 most recent sessions within the last 24h
    ///     that aren't already covered by active/pinned.
    ///
    /// Everything else stays cold and waits for the user to tap it
    /// (which triggers `ensureLoaded`). No 500-message budget — the
    /// per-call cost is bounded by tentacle's HARD_CAP=500 already.
    private static let warmupRecentSlots = 5
    private static let warmupRecencySeconds: TimeInterval = 24 * 60 * 60

    func runWarmup(digests: [SessionDigest]) {
        guard let appState else { return }
        let now = Date()
        let cache = appState.messageStore.persistentCache

        var eagerIds: Set<String> = []
        var recencyById: [String: Date] = [:]

        for digest in digests {
            guard digest.lastSeq > 0 else { continue }
            // Recency anchor: digest's preview timestamp, else disk
            // cache's most-recent persisted message timestamp.
            if let ts = digest.preview?.timestamp, let d = Self.parseISO(ts) {
                recencyById[digest.id] = d
            } else if let d = cache.getLastTimestamp(digest.id) {
                recencyById[digest.id] = d
            }
            let isActive = digest.state == .active
            let isPinned = (digest.pinned ?? false)
                || appState.sessionStore.pinnedSessions.contains(digest.id)
            if isActive || isPinned {
                eagerIds.insert(digest.id)
            }
        }

        // Top N most-recent within 24h, not already eager.
        let cutoff = now.addingTimeInterval(-Self.warmupRecencySeconds)
        let recentCandidates = digests
            .filter { d in
                guard d.lastSeq > 0, !eagerIds.contains(d.id) else { return false }
                guard let r = recencyById[d.id] else { return false }
                return r > cutoff
            }
            .sorted { (a, b) in
                (recencyById[a.id] ?? .distantPast) > (recencyById[b.id] ?? .distantPast)
            }
            .prefix(Self.warmupRecentSlots)
        for d in recentCandidates {
            eagerIds.insert(d.id)
        }

        for id in eagerIds {
            requestLatest(sessionId: id)
        }

        KLog.d("🔥 warm-up: \(eagerIds.count) sessions (\(eagerIds.count - recentCandidates.count) active/pinned, \(recentCandidates.count) recent)")
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
    func requestBefore(sessionId: String, beforeSeq: Int) {
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

        // Only short-circuit if the slot immediately below `beforeSeq`
        // is already in the store. Earlier code skipped on any store
        // overlap, which let a middle-only cache (e.g. a stale slice
        // hydrated from disk) silently leave a gap when latest-turn
        // fetch landed above it. We need to actually walk back from
        // `beforeSeq`.
        let storeMessages = appState.messageStore.getMessages(sessionId)
        if storeMessages.contains(where: { $0.seq == beforeSeq - 1 }) { return }

        requestFromTentacle(sessionId: sessionId, beforeSeq: beforeSeq)
    }

    // MARK: - Handle Batch

    /// Process a turn-aligned batch from tentacle. Inserts into store
    /// and clears in-flight tracking. If `containsHead == false` after
    /// asking for head (beforeSeq=nil request), schedule a follow-up
    /// `requestLatest` to catch up — guards against the rare case
    /// where a single in-progress turn exceeds tentacle's HARD_CAP.
    func handleBatch(
        sessionId: String,
        messages: [ChatMessage],
        lastSeq: Int,
        totalLastSeq: Int,
        containsHead: Bool
    ) {
        guard let appState else { return }

        KLog.d("📦 handleBatch(\(sessionId.prefix(12))): \(messages.count) msgs, lastSeq=\(lastSeq), totalLastSeq=\(totalLastSeq), head=\(containsHead)")

        // Snapshot store seqs *before* the prepend so we can spot a
        // hole between the incoming batch and what we already had.
        // Anything we have whose seq is strictly below the batch's
        // lowest seq is "prior content"; if the largest such seq is
        // not directly contiguous with batch.minSeq we have a gap.
        let batchMinSeq = messages.map(\.seq).min() ?? 0
        let priorMaxBelowBatch: Int = {
            guard batchMinSeq > 0 else { return 0 }
            let store = appState.messageStore.getMessages(sessionId)
            var best = 0
            for m in store where m.seq < batchMinSeq && m.seq > best { best = m.seq }
            return best
        }()

        if !messages.isEmpty {
            appState.messageStore.prependMessages(sessionId, messages)
            KLog.d("📦 Store now has \(appState.messageStore.getMessages(sessionId).count) msgs for \(sessionId.prefix(12))")
            processReplayedActions(sessionId: sessionId, messages: messages)
            rebuildPreview(sessionId: sessionId)
        }

        // Update tentacle last seq if server reports higher
        if totalLastSeq > (tentacleLastSeq[sessionId] ?? 0) {
            tentacleLastSeq[sessionId] = totalLastSeq
        }

        // Was this batch a "fetch head" request whose response didn't
        // actually reach head? Schedule a one-shot follow-up to catch
        // up. Rare — only happens when an in-progress turn exceeds
        // tentacle's HARD_CAP — but cheap insurance.
        let wasHeadRequest = pendingHeadRequests.remove(sessionId) != nil
        let needsCatchUp = wasHeadRequest && !containsHead
            && lastSeq < (tentacleLastSeq[sessionId] ?? 0)

        // Did we just land a batch above a pre-existing slice that
        // *isn't* contiguous with it? That means there's a silent
        // hole between [priorMaxBelowBatch+1 .. batchMinSeq-1] —
        // happens when disk holds a stale middle slice and the
        // latest-turn fetch anchors above it. Schedule a one-shot
        // bridge fetch ending at batchMinSeq; subsequent batches will
        // re-enter this guard and keep walking the hole closed.
        let needsGapBridge = batchMinSeq > 0
            && priorMaxBelowBatch > 0
            && batchMinSeq > priorMaxBelowBatch + 1

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

        // Sync follow-up dispatches: we're already on the main queue
        // (WS receive → MessageRouter → MessageProvider), and the
        // bridge / catch-up calls just enqueue another WS send. Doing
        // them synchronously prevents a one-runloop-turn window where
        // setLoading drops to false and the chat view's auto-load can
        // race in to send a duplicate before our follow-up registers.
        if needsCatchUp {
            KLog.d("⚠️ batch didn't reach head; firing follow-up requestLatest for \(sessionId.prefix(12))")
            requestLatest(sessionId: sessionId)
        }

        if needsGapBridge {
            KLog.d("🪡 detected gap [\(priorMaxBelowBatch + 1)..\(batchMinSeq - 1)] in \(sessionId.prefix(12)); bridging via requestBefore(beforeSeq=\(batchMinSeq))")
            requestBefore(sessionId: sessionId, beforeSeq: batchMinSeq)
        }
    }

    // MARK: - Preview

    /// Rebuild session preview from messages in the store.
    /// Scans backwards for the last meaningful message.
    ///
    /// Forked sessions need their fork timestamp preserved so they sort
    /// next to other freshly-touched sessions instead of next to their
    /// parent's old last-message. We detect this by comparing the
    /// existing preview's timestamp to the one we're about to write —
    /// if the existing one is newer (e.g. set by the `session_created`
    /// seed in MessageRouter), we keep its timestamp and only swap the
    /// text+type.
    func rebuildPreview(sessionId: String) {
        guard let appState else { return }
        let msgs = appState.messageStore.getMessages(sessionId)
        guard !msgs.isEmpty else { return }

        let existing = appState.sessionStore.sessionPreviews[sessionId]

        func write(text: String, type: String, timestamp: String) {
            // Forked / freshly imported sessions: preserve the newer
            // existing timestamp so their card doesn't sort by the
            // parent session's last-message clock.
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

    // MARK: - Replay Action Processing

    /// Scan replayed messages for pending permissions/questions that weren't processed live.
    func processReplayedActions(sessionId: String, messages: [ChatMessage]) {
        guard let appState else { return }

        // Collect resolved IDs
        var resolvedPermIds = Set<String>()
        var resolvedQuestionIds = Set<String>()
        var permResolutions: [String: String] = [:]
        var questionAnswers: [String: String] = [:]

        for msg in messages {
            switch msg.type {
            case "approve":
                if let pid = msg.payload["permissionId"]?.stringValue {
                    resolvedPermIds.insert(pid)
                    permResolutions[pid] = "approved"
                }
            case "deny":
                if let pid = msg.payload["permissionId"]?.stringValue {
                    resolvedPermIds.insert(pid)
                    permResolutions[pid] = "denied"
                }
            case "always_allow":
                if let pid = msg.payload["permissionId"]?.stringValue {
                    resolvedPermIds.insert(pid)
                    permResolutions[pid] = "always_allowed"
                }
            case "permission_resolved":
                if let pid = msg.payload["permissionId"]?.stringValue {
                    resolvedPermIds.insert(pid)
                    permResolutions[pid] = msg.payload["resolution"]?.stringValue ?? "approved"
                }
            case "answer":
                if let qid = msg.payload["questionId"]?.stringValue {
                    resolvedQuestionIds.insert(qid)
                    questionAnswers[qid] = msg.payload["answer"]?.stringValue ?? ""
                }
            case "question_resolved":
                if let qid = msg.payload["questionId"]?.stringValue {
                    resolvedQuestionIds.insert(qid)
                    questionAnswers[qid] = msg.payload["answer"]?.stringValue ?? ""
                }
            default:
                break
            }
        }

        // Add unresolved permissions
        for msg in messages where msg.type == "permission" {
            guard let pid = msg.permissionId, !resolvedPermIds.contains(pid) else { continue }
            guard appState.messageStore.pendingPermissions[pid] == nil else { continue }

            let ts: Date
            if let tsStr = msg.timestamp {
                let fmt = ISO8601DateFormatter()
                fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                ts = fmt.date(from: tsStr) ?? Date()
            } else {
                ts = Date()
            }

            let perm = PendingPermission(
                id: pid,
                sessionId: sessionId,
                description: msg.toolDescription ?? "",
                toolName: msg.toolName,
                args: msg.args,
                timestamp: ts
            )
            appState.messageStore.addPermission(perm)
        }

        // Add unresolved questions
        for msg in messages where msg.type == "question" {
            guard let qid = msg.questionId, !resolvedQuestionIds.contains(qid) else { continue }
            guard appState.messageStore.pendingQuestions[qid] == nil else { continue }

            let ts: Date
            if let tsStr = msg.timestamp {
                let fmt = ISO8601DateFormatter()
                fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                ts = fmt.date(from: tsStr) ?? Date()
            } else {
                ts = Date()
            }

            let q = PendingQuestion(
                id: qid,
                sessionId: sessionId,
                question: msg.question ?? "",
                choices: msg.choices,
                timestamp: ts
            )
            appState.messageStore.addQuestion(q)
        }

        // Stamp resolutions on messages so UI renders them correctly
        for (permId, resolution) in permResolutions {
            appState.messageStore.resolvePermissionMessage(sessionId, permissionId: permId, resolution: resolution)
            appState.messageStore.removePermission(permId)
        }
        for (qId, answer) in questionAnswers {
            appState.messageStore.resolveQuestionMessage(sessionId, questionId: qId, answerText: answer)
            appState.messageStore.removeQuestion(qId)
        }
    }

    // MARK: - Private

    private func requestFromTentacle(sessionId: String, beforeSeq: Int?) {
        guard tentacleDeviceMap[sessionId] != nil else { return }
        guard let appState else { return }

        // Use beforeSeq as the dedupe key so head-fetches (nil → "head")
        // don't collide with paginated older-fetches.
        let loadKey = "\(sessionId):\(beforeSeq.map(String.init) ?? "head")"
        inFlightRequests.insert(loadKey)
        if beforeSeq == nil { pendingHeadRequests.insert(sessionId) }
        appState.sessionStore.setLoading(sessionId, true)

        appState.commandSender?.requestSessionMessages(
            sessionId: sessionId,
            beforeSeq: beforeSeq
        )

        // Safety timeout — drop the in-flight marker if no batch arrives.
        let work = DispatchWorkItem { [weak self, weak appState] in
            self?.inFlightRequests.remove(loadKey)
            self?.pendingHeadRequests.remove(sessionId)
            appState?.sessionStore.setLoading(sessionId, false)
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
        appState?.sessionStore.loadingSessions.removeAll()
    }
}
