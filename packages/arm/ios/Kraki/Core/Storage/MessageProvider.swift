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
        guard !isLoading(sessionId) else { return }
        guard let totalLastSeq = tentacleLastSeq[sessionId], totalLastSeq > 0 else { return }
        guard let appState else { return }

        // Check in-memory store first
        let storeLastSeq = appState.messageStore.getLastSeq(sessionId)

        if storeLastSeq > 0 {
            // Already have some messages — rebuild preview from what we have
            rebuildPreview(sessionId: sessionId)
        }

        // If tentacle has newer messages, request the gap
        if storeLastSeq < totalLastSeq {
            let afterSeq = max(storeLastSeq, totalLastSeq - Self.latestSize)
            if afterSeq < totalLastSeq {
                requestFromTentacle(sessionId: sessionId, afterSeq: afterSeq)
            }
        }
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

        if !messages.isEmpty {
            appState.messageStore.prependMessages(sessionId, messages)
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
    func rebuildPreview(sessionId: String) {
        guard let appState else { return }
        let msgs = appState.messageStore.getMessages(sessionId)
        guard !msgs.isEmpty else { return }

        for i in stride(from: msgs.count - 1, through: 0, by: -1) {
            let m = msgs[i]

            switch m.type {
            case "question":
                let q = m.question ?? ""
                appState.sessionStore.setPreview(sessionId, text: String(q.prefix(Self.previewMaxLength)), type: "question", timestamp: m.timestamp ?? "")
                return
            case "permission":
                let tool = m.toolName ?? ""
                appState.sessionStore.setPreview(sessionId, text: String(tool.prefix(Self.previewMaxLength)), type: "permission", timestamp: m.timestamp ?? "")
                return
            case "error":
                let errMsg = m.errorMessage ?? "Error"
                appState.sessionStore.setPreview(sessionId, text: String(errMsg.prefix(Self.previewMaxLength)), type: "error", timestamp: m.timestamp ?? "")
                return
            case "user_message":
                let content = m.content ?? ""
                appState.sessionStore.setPreview(sessionId, text: String(content.prefix(Self.previewMaxLength)), type: "user", timestamp: m.timestamp ?? "")
                return
            case "answer":
                let answer = m.answer ?? ""
                if !answer.isEmpty {
                    appState.sessionStore.setPreview(sessionId, text: String(answer.prefix(Self.previewMaxLength)), type: "answer", timestamp: m.timestamp ?? "")
                    return
                }
            case "agent_message":
                let content = m.content ?? ""
                let next = i + 1 < msgs.count ? msgs[i + 1] : nil
                if next == nil || next?.type == "idle" {
                    appState.sessionStore.setPreview(sessionId, text: String(content.prefix(Self.previewMaxLength)), type: "agent", timestamp: m.timestamp ?? "")
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
