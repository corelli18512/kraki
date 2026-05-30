/// CommandSender — Outgoing command builder mirroring commands.ts.
///
/// Each command:
///   1. Applies optimistic local updates to stores
///   2. Sends the message via WebSocket (encryption handled by AppState)
///
/// Holds a weak reference to AppState for accessing stores and send function.

import Foundation
import Observation

@Observable
final class CommandSender {
    /// requestId → initial prompt for session creation correlation.
    var pendingCreateRequests: [String: String] = [:]
    /// requestId → title to apply after session is created.
    var pendingCreateTitles: [String: String] = [:]
    /// requestId → placeholder session id used as the navigation token
    /// during optimistic create/fork. When `session_created` arrives
    /// with this requestId, the router swaps placeholderId → real id.
    var pendingPlaceholderIds: [String: String] = [:]
    /// Count of in-flight mode changes per session (for echo suppression).
    private var pendingModeChanges: [String: Int] = [:]

    private weak var appState: AppState?

    init(appState: AppState) {
        self.appState = appState
    }

    // MARK: - Send Helpers

    /// Send an encrypted message through the WebSocket.
    /// The actual encryption + routing is handled by AppState/networking layer.
    private func send(_ payload: [String: Any], sessionId: String? = nil) {
        guard let appState else { return }
        var msg = payload
        if let sessionId { msg["sessionId"] = sessionId }
        msg["deviceId"] = appState.deviceId ?? ""
        msg["seq"] = 0
        msg["timestamp"] = ISO8601.now()
        appState.sendEncryptedMessage(msg)
    }

    // MARK: - Input

    func sendInput(sessionId: String, text: String, attachments: [ImageAttachment]? = nil) {
        guard let appState else { return }

        // Generate a correlation id. Tentacle echoes this back inside
        // the resulting `user_message.payload.clientId`, letting us
        // resolve the right pending placeholder even with multiple
        // in-flight sends, reconnects, or multi-device scenarios.
        let clientId = UUID().uuidString

        // Optimistic: insert pending_input. Stash attachments on the
        // pending payload so the pending bubble can render the image
        // grid immediately (otherwise the image only appears after the
        // server echoes user_message back). The `attachments` accessor
        // on ChatMessage reads from `payload.attachments`, so we
        // encode them in the same shape the server's user_message
        // uses — array of [type, mimeType, data] dicts.
        var pendingPayload: [String: AnyCodable] = [
            "content": AnyCodable(text),
            "clientId": AnyCodable(clientId),
        ]
        if let attachments, !attachments.isEmpty {
            let encodedAttachments = attachments.map { att -> [String: String] in
                ["type": att.type, "mimeType": att.mimeType, "data": att.data]
            }
            pendingPayload["attachments"] = AnyCodable(encodedAttachments)
        }
        let pending = ChatMessage(
            type: "pending_input",
            seq: 0,
            sessionId: sessionId,
            deviceId: appState.deviceId,
            timestamp: ISO8601.now(),
            payload: pendingPayload
        )
        appState.messageStore.append(sessionId, pending)

        var payload: [String: Any] = ["text": text, "clientId": clientId]
        if let attachments, !attachments.isEmpty {
            let encoded = attachments.map { att -> [String: String] in
                ["type": att.type, "mimeType": att.mimeType, "data": att.data]
            }
            payload["attachments"] = encoded
        }
        send(["type": "send_input", "payload": payload], sessionId: sessionId)
    }

    // MARK: - Permissions

    // Permission / question resolve buttons send the command and
    // rely on tentacle's `permission_resolved` / `question_resolved`
    // echo to materialise the badge on the bubble (grouper folds the
    // resolver into the originating row). Round-trip is ~100-300ms;
    // future work could layer in optimistic UI via the pending_input
    // pattern (see the storage-refactor discussion).
    func approve(sessionId: String, permissionId: String) {
        send(["type": "approve", "payload": ["permissionId": permissionId]], sessionId: sessionId)
    }

    func deny(sessionId: String, permissionId: String, reason: String? = nil) {
        var payload: [String: Any] = ["permissionId": permissionId]
        if let reason, !reason.isEmpty {
            payload["reason"] = reason
        }
        send(["type": "deny", "payload": payload], sessionId: sessionId)
    }

    func alwaysAllow(sessionId: String, permissionId: String, toolKind: String? = nil) {
        var payload: [String: Any] = ["permissionId": permissionId]
        if let toolKind { payload["toolKind"] = toolKind }
        send(["type": "always_allow", "payload": payload], sessionId: sessionId)
    }

    // MARK: - Questions

    func answer(sessionId: String, questionId: String, answer: String) {
        send([
            "type": "answer",
            "payload": ["questionId": questionId, "answer": answer],
        ], sessionId: sessionId)
    }

    // MARK: - Session Control

    func killSession(sessionId: String) {
        send(["type": "kill_session", "payload": [:] as [String: Any]], sessionId: sessionId)
    }

    func abortSession(sessionId: String) {
        send(["type": "abort_session", "payload": [:] as [String: Any]], sessionId: sessionId)
    }

    // MARK: - Session Mode

    func setSessionMode(sessionId: String, mode: SessionMode) {
        guard let appState else { return }

        // Track for echo suppression
        pendingModeChanges[sessionId, default: 0] += 1

        send(["type": "set_session_mode", "payload": ["mode": mode.rawValue]], sessionId: sessionId)
        appState.sessionStore.setMode(sessionId, mode)

        // Auto-resolve pending permissions based on the new mode.
        // Pending permissions are derived from the message DB: a
        // `permission` row with no `resolution` stamp and no
        // matching approve/deny/always_allow/permission_resolved in
        // the same session. Window-state-agnostic since this can
        // fire for a session the user hasn't opened.
        let pending = pendingPermissions(in: sessionId)

        switch mode {
        case .execute, .delegate:
            for perm in pending {
                send(["type": "approve", "payload": ["permissionId": perm.id]], sessionId: sessionId)
            }
        case .discuss:
            for perm in pending {
                let isWrite = perm.toolName == "write" || perm.toolName == "write_file"
                    || perm.toolName == "create" || perm.toolName == "edit"
                let filePath = perm.args?["path"]?.stringValue ?? ""
                let isPlanMd = filePath.hasSuffix("/plan.md") || filePath == "plan.md"

                if !isWrite || isPlanMd {
                    send(["type": "approve", "payload": ["permissionId": perm.id]], sessionId: sessionId)
                } else {
                    send(["type": "deny", "payload": ["permissionId": perm.id]], sessionId: sessionId)
                }
            }
        case .safe:
            break // No auto-resolution in safe mode
        }
    }

    /// Derive currently-unresolved permission requests for a session
    /// from the persisted message stream. Used by mode-change
    /// auto-resolution; the old code held a dedicated dict, but the
    /// truth lives in the message log so we just read it. Bounded
    /// scan (recent 100 messages) — old permissions that never got
    /// resolved still surface from there.
    private func pendingPermissions(in sessionId: String) -> [PendingPermission] {
        guard let appState else { return [] }
        let msgs = appState.messageStore.recentFromDB(sessionId, limit: 100)
        var resolvedIds = Set<String>()
        for m in msgs {
            switch m.type {
            case "approve", "deny", "always_allow", "permission_resolved":
                if let pid = m.payload["permissionId"]?.stringValue {
                    resolvedIds.insert(pid)
                }
            default:
                break
            }
        }
        var out: [PendingPermission] = []
        for m in msgs where m.type == "permission" {
            guard let pid = m.permissionId else { continue }
            // Resolved iff a matching approve/deny/always_allow/
            // permission_resolved appears later in the stream.
            if resolvedIds.contains(pid) { continue }
            out.append(PendingPermission(
                id: pid,
                sessionId: sessionId,
                description: m.toolDescription ?? "",
                toolName: m.toolName,
                args: m.args,
                timestamp: Date()  // close-enough; only used for ordering on UI
            ))
        }
        return out
    }

    /// Consume one pending mode echo. Returns true if this was our own echo.
    func consumeModeEcho(_ sessionId: String) -> Bool {
        guard let count = pendingModeChanges[sessionId], count > 0 else { return false }
        if count == 1 {
            pendingModeChanges.removeValue(forKey: sessionId)
        } else {
            pendingModeChanges[sessionId] = count - 1
        }
        return true
    }

    // MARK: - Session Model

    func setSessionModel(sessionId: String, model: String, reasoningEffort: ReasoningEffort? = nil) {
        guard let appState else { return }

        var payload: [String: Any] = ["model": model]
        if let reasoningEffort { payload["reasoningEffort"] = reasoningEffort.rawValue }
        send(["type": "set_session_model", "payload": payload], sessionId: sessionId)

        // Optimistic update
        appState.sessionStore.setModel(sessionId, model)
    }

    // MARK: - Session Lifecycle

    /// Create a new session. Returns the requestId for tracking. Also
    /// allocates a client-side placeholder session id, navigates to
    /// it immediately so the user sees a "Starting session…" screen
    /// while the tentacle responds. When `session_created` arrives,
    /// the router swaps the placeholder for the real id.
    @discardableResult
    func createSession(
        targetDeviceId: String,
        model: String,
        reasoningEffort: ReasoningEffort? = nil,
        prompt: String? = nil,
        cwd: String? = nil,
        title: String? = nil
    ) -> String {
        let requestId = "req_" + UUID().uuidString.lowercased()
        let placeholderId = "pending-\(UUID().uuidString.lowercased())"

        if let prompt {
            pendingCreateRequests[requestId] = prompt
        } else {
            pendingCreateRequests[requestId] = ""
        }

        if let title, !title.isEmpty {
            pendingCreateTitles[requestId] = title
        }

        pendingPlaceholderIds[requestId] = placeholderId

        if let appState {
            appState.sessionStore.addPendingSession(placeholderId)
            appState.sessionStore.navigateToSession = placeholderId
            schedulePendingTimeout(requestId: requestId)
        }

        var payload: [String: Any] = [
            "requestId": requestId,
            "targetDeviceId": targetDeviceId,
            "model": model,
        ]
        if let reasoningEffort { payload["reasoningEffort"] = reasoningEffort.rawValue }
        if let prompt { payload["prompt"] = prompt }
        if let cwd { payload["cwd"] = cwd }

        send(["type": "create_session", "payload": payload])
        return requestId
    }

    func forkSession(sessionId: String) {
        let requestId = "req_" + UUID().uuidString.lowercased()
        let placeholderId = "pending-\(UUID().uuidString.lowercased())"
        pendingCreateRequests[requestId] = ""
        pendingPlaceholderIds[requestId] = placeholderId

        if let appState {
            appState.sessionStore.addPendingSession(placeholderId)
            appState.sessionStore.navigateToSession = placeholderId
            schedulePendingTimeout(requestId: requestId)
        }

        send([
            "type": "fork_session",
            "payload": ["requestId": requestId, "sourceSessionId": sessionId],
        ], sessionId: sessionId)
    }

    /// Import a local session into the tentacle. The `localSessionId`
    /// also serves as the future session id, so we can mark it
    /// pending and navigate immediately without waiting for a server
    /// response. Picker metadata (cwd / summary / source / model /
    /// branch / startTime) is passed through so the tentacle can skip
    /// re-scanning the filesystem.
    @discardableResult
    func importSession(
        localSessionId: String,
        targetDeviceId: String,
        meta: [String: Any]? = nil
    ) -> String {
        let requestId = "req_" + UUID().uuidString.lowercased()
        pendingCreateRequests[requestId] = ""
        // For import, the localSessionId IS the future session id.
        pendingPlaceholderIds[requestId] = localSessionId

        if let appState {
            appState.sessionStore.addPendingSession(localSessionId)
            appState.sessionStore.navigateToSession = localSessionId
            schedulePendingTimeout(requestId: requestId)
        }

        var payload: [String: Any] = [
            "requestId": requestId,
            "localSessionId": localSessionId,
            "targetDeviceId": targetDeviceId,
        ]
        if let meta { payload["meta"] = meta }

        send(["type": "import_session", "payload": payload])
        return requestId
    }

    /// Per-pending-request timeout. If `session_created` doesn't land
    /// within 30 s, fail the placeholder with a "timed out" error so
    /// the UI doesn't hang forever.
    private func schedulePendingTimeout(requestId: String) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard let self,
                  let placeholderId = self.pendingPlaceholderIds[requestId],
                  let appState = self.appState,
                  appState.sessionStore.isPending(placeholderId) else { return }
            appState.sessionStore.setPendingError(
                placeholderId,
                reason: "Request timed out"
            )
            self.clearPendingRequest(requestId)
        }
    }

    /// Drop in-flight bookkeeping for a requestId (resolution, error,
    /// or timeout). Does NOT touch the SessionStore's pending entry —
    /// that's owned by router/UI for swap-out logic.
    func clearPendingRequest(_ requestId: String) {
        pendingCreateRequests.removeValue(forKey: requestId)
        pendingCreateTitles.removeValue(forKey: requestId)
        pendingPlaceholderIds.removeValue(forKey: requestId)
    }

    func deleteSession(sessionId: String) {
        guard let appState else { return }
        send(["type": "delete_session", "payload": [:] as [String: Any]], sessionId: sessionId)
        appState.sessionStore.removeSession(sessionId)
        appState.messageStore.deleteSessionMessages(sessionId)
    }

    // MARK: - Device Lifecycle

    /// Remove a device from the user's account. Routed through the
    /// command layer (not raw `sendEncryptedMessage`) so it shares the
    /// same connectivity/queue semantics as other commands and won't
    /// silently disappear if the socket is mid-reconnect.
    func removeDevice(deviceId: String) {
        send(["type": "remove_device", "deviceId": deviceId])
    }

    // MARK: - Local sessions (import picker)

    /// Ask a tentacle for its catalog of importable local sessions.
    /// The tentacle responds with `local_sessions_list` which the
    /// router lands into `deviceStore.localSessions[deviceId]`.
    func requestLocalSessions(
        targetDeviceId: String,
        search: String? = nil,
        liveOnly: Bool = false,
        includeLinked: Bool = false
    ) {
        guard let appState else { return }
        appState.deviceStore.localSessionsLoading.insert(targetDeviceId)
        var filter: [String: Any] = [:]
        if let search, !search.isEmpty { filter["search"] = search }
        if liveOnly { filter["liveOnly"] = true }
        if includeLinked { filter["includeLinked"] = true }
        var payload: [String: Any] = [:]
        if !filter.isEmpty { payload["filter"] = filter }
        send([
            "type": "request_local_sessions",
            "targetDeviceId": targetDeviceId,
            "payload": payload,
        ])
    }

    // MARK: - Read State

    func markRead(sessionId: String, seq: Int) {
        guard let appState else { return }
        send(["type": "mark_read", "payload": ["seq": seq]], sessionId: sessionId)
        appState.sessionStore.markRead(sessionId, seq: seq)
    }

    func markUnread(sessionId: String) {
        guard let appState else { return }
        send(["type": "mark_unread", "payload": [:] as [String: Any]], sessionId: sessionId)
        // Optimistically reflect the server's rollback semantics:
        // tentacle does `readSeq = max(0, lastSeq − 1)`, which yields
        // one unread message. Once the `session_read` echo arrives
        // the monotonic max keeps us consistent.
        if let session = appState.sessionStore.session(for: sessionId), session.lastSeq > 0 {
            let rolledBack = max(0, session.lastSeq - 1)
            appState.sessionStore.sessions[sessionId]?.readSeq = rolledBack
        }
    }

    // MARK: - Session Metadata

    func renameSession(sessionId: String, title: String) {
        guard let appState else { return }
        // Optimistic
        appState.sessionStore.setTitle(sessionId, title: title.isEmpty ? nil : title, autoTitle: nil)
        send(["type": "rename_session", "payload": ["title": title]], sessionId: sessionId)
    }

    func pinSession(sessionId: String, pinned: Bool) {
        guard let appState else { return }
        // Optimistic
        appState.sessionStore.setPinned(sessionId, pinned)
        send(["type": "pin_session", "payload": ["pinned": pinned]], sessionId: sessionId)
    }

    // MARK: - Replay

    /// Deprecated: legacy message-count pagination. Kept only for
    /// backwards compatibility while the new endpoint stabilises.
    /// New code should call `requestSessionMessages` instead.
    func requestReplay(sessionId: String, afterSeq: Int, limit: Int? = nil) {
        var payload: [String: Any] = ["sessionId": sessionId, "afterSeq": afterSeq]
        if let limit { payload["limit"] = limit }
        send(["type": "request_session_replay", "payload": payload], sessionId: sessionId)
    }

    /// Ask the tentacle for turn-aligned messages.
    ///
    /// - `beforeSeq == nil` → tentacle anchors at the latest turn and
    ///   extends back through earlier whole turns up to its soft cap.
    ///   This is the "fetch the latest" path.
    /// - `beforeSeq == X`   → tentacle returns the immediate slice of
    ///   prior turns ending at `X - 1`. This is the "page older" path.
    ///
    /// Reply arrives as a `session_messages_batch` envelope and is
    /// handled by `MessageProvider.handleBatch`.
    func requestSessionMessages(sessionId: String, beforeSeq: Int? = nil) {
        var payload: [String: Any] = ["sessionId": sessionId]
        if let beforeSeq { payload["beforeSeq"] = beforeSeq }
        send(["type": "request_session_messages", "payload": payload], sessionId: sessionId)
    }

    // MARK: - Cleanup

    /// Clean up a failed create request.
    func clearRequest(_ requestId: String) {
        pendingCreateRequests.removeValue(forKey: requestId)
    }

    /// Resolve a create request — correlate the requestId with the created sessionId.
    func resolveCreateRequest(_ requestId: String, sessionId: String) {
        guard let appState else { return }
        // Apply pending title (if any) before sending input
        if let title = pendingCreateTitles.removeValue(forKey: requestId), !title.isEmpty {
            renameSession(sessionId: sessionId, title: title)
        }
        // Swap the optimistic placeholder for the real session id, if
        // we had pre-navigated. The router has already inserted the
        // real session into the store; we just need to retire the
        // placeholder entry and re-point navigation.
        if let placeholderId = pendingPlaceholderIds.removeValue(forKey: requestId) {
            if placeholderId != sessionId {
                appState.sessionStore.removePendingSession(placeholderId)
            } else {
                // Import path: localSessionId == real sessionId. Drop
                // pending mark now that the session exists for real.
                appState.sessionStore.removePendingSession(sessionId)
            }
            appState.sessionStore.navigateToSession = sessionId
        }
        if let prompt = pendingCreateRequests.removeValue(forKey: requestId) {
            // If we had a prompt, send it now
            if !prompt.isEmpty {
                sendInput(sessionId: sessionId, text: prompt)
            }
        }
    }

    /// Mark a pending request as failed (server-side `error` carrying
    /// our `requestId`). Surfaces the reason on the placeholder so the
    /// view can render an error state with Back.
    func failPendingRequest(_ requestId: String, reason: String) {
        guard let appState else { return }
        if let placeholderId = pendingPlaceholderIds.removeValue(forKey: requestId) {
            appState.sessionStore.setPendingError(placeholderId, reason: reason)
        }
        pendingCreateRequests.removeValue(forKey: requestId)
        pendingCreateTitles.removeValue(forKey: requestId)
    }

    func reset() {
        pendingCreateRequests.removeAll()
        pendingCreateTitles.removeAll()
        pendingPlaceholderIds.removeAll()
        pendingModeChanges.removeAll()
    }
}
