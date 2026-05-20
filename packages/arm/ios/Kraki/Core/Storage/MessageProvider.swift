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

    /// Load latest messages for a session. Called for every session after session_list arrives.
    func requestLatest(sessionId: String) {
        guard !isLoading(sessionId) else {
            KLog.d("⏳ requestLatest(\(sessionId.prefix(12))): already loading")
            return
        }
        guard let totalLastSeq = tentacleLastSeq[sessionId], totalLastSeq > 0 else {
            KLog.d("⏭️ requestLatest(\(sessionId.prefix(12))): no tentacleLastSeq (keys: \(tentacleLastSeq.keys.map { String($0.prefix(12)) }))")
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

        if storeLastSeq < totalLastSeq {
            let afterSeq = max(storeLastSeq, totalLastSeq - Self.latestSize)
            if afterSeq < totalLastSeq {
                KLog.d("📨 Requesting replay afterSeq=\(afterSeq) for \(sessionId.prefix(12))")
                requestFromTentacle(sessionId: sessionId, afterSeq: afterSeq)
            }
        }
    }

    // MARK: - Warm-up budget

    /// Budget warm-up — mirrors `runWarmup` in web's ws-client.ts.
    ///
    /// Goal: after `session_list` paints the sidebar, pre-fetch messages
    /// for the sessions the user is likely to open next, while bounding
    /// total bandwidth.
    ///
    /// Algorithm:
    ///   - **Pass 0 fallback**: if no digest has any recency signal at
    ///     all (no preview from tentacle AND nothing in our local
    ///     cache), warm everything with `lastSeq > 0`, 50 msgs each. We
    ///     pay this cost once; subsequent reloads will have cache
    ///     timestamps.
    ///   - **Pass 1 (always, ignores budget)**: warm every session that
    ///     is `active`, pinned, or whose recency timestamp is within
    ///     `WARMUP_RECENCY_MS`.
    ///   - **Pass 2 (fills budget)**: sort `rest` by recency desc,
    ///     greedily warm each until the next would exceed
    ///     `WARMUP_BUDGET`. Stop.
    ///
    /// "Recency timestamp" is the digest's `preview.timestamp` if the
    /// tentacle sent one; otherwise the most recent persisted message's
    /// timestamp from the disk cache. This means a returning user with
    /// an old cache still gets sensible eager classification even if
    /// the tentacle preview is missing for some reason.
    private static let warmupBudget = 500
    private static let warmupPerSession = 50
    private static let warmupRecencySeconds: TimeInterval = 24 * 60 * 60

    func runWarmup(digests: [SessionDigest]) {
        guard let appState else { return }
        let now = Date()

        struct Entry {
            let id: String
            let lastSeq: Int
            let recency: Date?
            let eager: Bool
        }

        var hasAnyRecencySignal = false
        let cache = appState.messageStore.persistentCache

        let entries: [Entry] = digests.compactMap { (digest: SessionDigest) -> Entry? in
            guard digest.lastSeq > 0 else { return nil }
            let isPinned = appState.sessionStore.pinnedSessions.contains(digest.id)
                || (digest.pinned ?? false)
            let isActive = digest.state == .active

            let recency: Date? = {
                if let ts = digest.preview?.timestamp,
                   let d = Self.parseISO(ts) { return d }
                if let d = cache.getLastTimestamp(digest.id) { return d }
                return nil
            }()
            if recency != nil { hasAnyRecencySignal = true }

            let withinRecency: Bool = {
                guard let r = recency else { return false }
                return now.timeIntervalSince(r) < Self.warmupRecencySeconds
            }()
            let eager = isActive || isPinned || withinRecency
            return Entry(
                id: digest.id,
                lastSeq: digest.lastSeq,
                recency: recency,
                eager: eager
            )
        }

        // Pass 0 fallback — no recency signal anywhere → warm all so the
        // user isn't stranded with empty cards.
        if !hasAnyRecencySignal {
            KLog.d("🔥 warm-up: no recency signal, warming all (\(entries.count) sessions)")
            for e in entries {
                requestLatest(sessionId: e.id)
            }
            return
        }

        let eager = entries.filter { $0.eager }
        let rest = entries.filter { !$0.eager }
            .sorted { (a, b) in
                (a.recency ?? .distantPast) > (b.recency ?? .distantPast)
            }

        // Pass 1 — eager, ignores budget
        var used = 0
        for e in eager {
            requestLatest(sessionId: e.id)
            used += min(e.lastSeq, Self.warmupPerSession)
        }

        // Pass 2 — budget fill
        var filled = 0
        for e in rest {
            let cost = min(e.lastSeq, Self.warmupPerSession)
            if used + cost > Self.warmupBudget { break }
            requestLatest(sessionId: e.id)
            used += cost
            filled += 1
        }

        KLog.d("🔥 warm-up: eager=\(eager.count) budgetFill=\(filled) skipped=\(rest.count - filled) totalMsgs=\(used) budget=\(Self.warmupBudget)")
    }

    private static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    // MARK: - Request Before (Pagination)

    /// Load older messages before a given seq. Called from gap marker / scroll-up.
    func requestBefore(sessionId: String, beforeSeq: Int) {
        guard !isLoading(sessionId) else { return }
        guard let appState else { return }

        let loadKey = "\(sessionId):\(beforeSeq)"
        inFlightRequests.insert(loadKey)

        // Check if we already have older messages in the store
        let storeMessages = appState.messageStore.getMessages(sessionId)
        let storeMinSeq = storeMessages.first?.seq ?? Int.max

        // If we have messages below beforeSeq, they're already visible
        if storeMinSeq < beforeSeq && storeMinSeq > 1 {
            inFlightRequests.remove(loadKey)
            return
        }

        // Request from tentacle
        guard tentacleDeviceMap[sessionId] != nil else {
            inFlightRequests.remove(loadKey)
            return
        }

        let afterSeq = max(0, beforeSeq - Self.pageSize - 1)
        appState.commandSender?.requestReplay(
            sessionId: sessionId,
            afterSeq: afterSeq,
            limit: Self.pageSize
        )

        // Safety timeout: clear loading after 10s
        let work = DispatchWorkItem { [weak self] in
            self?.inFlightRequests.remove(loadKey)
        }
        timeoutTasks[loadKey] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    // MARK: - Handle Batch

    /// Process a replay batch from tentacle. Inserts into store and clears loading.
    func handleBatch(
        sessionId: String,
        messages: [ChatMessage],
        lastSeq: Int,
        totalLastSeq: Int
    ) {
        guard let appState else { return }

        KLog.d("📦 handleBatch(\(sessionId.prefix(12))): \(messages.count) msgs, lastSeq=\(lastSeq), totalLastSeq=\(totalLastSeq)")

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

        // Clear all in-flight keys for this session
        let keysToRemove = inFlightRequests.filter { $0.hasPrefix("\(sessionId):") }
        for key in keysToRemove {
            inFlightRequests.remove(key)
            timeoutTasks[key]?.cancel()
            timeoutTasks.removeValue(forKey: key)
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

    private func requestFromTentacle(sessionId: String, afterSeq: Int, limit: Int? = nil) {
        guard tentacleDeviceMap[sessionId] != nil else { return }
        guard let appState else { return }

        let loadKey = "\(sessionId):\(afterSeq)"
        inFlightRequests.insert(loadKey)

        appState.commandSender?.requestReplay(
            sessionId: sessionId,
            afterSeq: afterSeq,
            limit: limit
        )

        // Safety timeout
        let work = DispatchWorkItem { [weak self] in
            self?.inFlightRequests.remove(loadKey)
        }
        timeoutTasks[loadKey] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    // MARK: - Cleanup

    func clear() {
        inFlightRequests.removeAll()
        tentacleLastSeq.removeAll()
        tentacleDeviceMap.removeAll()
        for (_, work) in timeoutTasks { work.cancel() }
        timeoutTasks.removeAll()
    }
}
