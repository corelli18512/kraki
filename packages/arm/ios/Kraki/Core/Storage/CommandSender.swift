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
        msg["timestamp"] = ISO8601DateFormatter().string(from: Date())
        appState.sendEncryptedMessage(msg)
    }

    // MARK: - Input

    func sendInput(sessionId: String, text: String, attachments: [ImageAttachment]? = nil) {
        guard let appState else { return }

        // Optimistic: insert pending_input
        let pending = ChatMessage(
            type: "pending_input",
            seq: 0,
            sessionId: sessionId,
            deviceId: appState.deviceId,
            timestamp: ISO8601DateFormatter().string(from: Date()),
            payload: [
                "content": AnyCodable(text),
            ]
        )
        appState.messageStore.appendMessage(sessionId, pending)

        var payload: [String: Any] = ["text": text]
        if let attachments, !attachments.isEmpty {
            let encoded = attachments.map { att -> [String: String] in
                ["type": att.type, "mimeType": att.mimeType, "data": att.data]
            }
            payload["attachments"] = encoded
        }
        send(["type": "send_input", "payload": payload], sessionId: sessionId)
    }

    // MARK: - Permissions

    func approve(sessionId: String, permissionId: String) {
        guard let appState else { return }
        send(["type": "approve", "payload": ["permissionId": permissionId]], sessionId: sessionId)
        appState.messageStore.removePermission(permissionId)
        appState.messageStore.resolvePermissionMessage(sessionId, permissionId: permissionId, resolution: "approved")
    }

    func deny(sessionId: String, permissionId: String) {
        guard let appState else { return }
        send(["type": "deny", "payload": ["permissionId": permissionId]], sessionId: sessionId)
        appState.messageStore.removePermission(permissionId)
        appState.messageStore.resolvePermissionMessage(sessionId, permissionId: permissionId, resolution: "denied")
    }

    func alwaysAllow(sessionId: String, permissionId: String, toolKind: String? = nil) {
        guard let appState else { return }
        var payload: [String: Any] = ["permissionId": permissionId]
        if let toolKind { payload["toolKind"] = toolKind }
        send(["type": "always_allow", "payload": payload], sessionId: sessionId)
        appState.messageStore.removePermission(permissionId)
        appState.messageStore.resolvePermissionMessage(sessionId, permissionId: permissionId, resolution: "always_allowed")
    }

    // MARK: - Questions

    func answer(sessionId: String, questionId: String, answer: String) {
        guard let appState else { return }
        send([
            "type": "answer",
            "payload": ["questionId": questionId, "answer": answer],
        ], sessionId: sessionId)
        appState.messageStore.removeQuestion(questionId)
        appState.messageStore.resolveQuestionMessage(sessionId, questionId: questionId, answerText: answer)
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

        // Auto-resolve pending permissions based on mode
        let pending = appState.messageStore.permissionsForSession(sessionId)

        switch mode {
        case .execute, .delegate:
            for perm in pending {
                send(["type": "approve", "payload": ["permissionId": perm.id]], sessionId: sessionId)
                appState.messageStore.removePermission(perm.id)
                appState.messageStore.resolvePermissionMessage(sessionId, permissionId: perm.id, resolution: "approved")
            }
        case .discuss:
            for perm in pending {
                let isWrite = perm.toolName == "write" || perm.toolName == "write_file"
                    || perm.toolName == "create" || perm.toolName == "edit"
                let filePath = perm.args?["path"]?.stringValue ?? ""
                let isPlanMd = filePath.hasSuffix("/plan.md") || filePath == "plan.md"

                if !isWrite || isPlanMd {
                    send(["type": "approve", "payload": ["permissionId": perm.id]], sessionId: sessionId)
                    appState.messageStore.removePermission(perm.id)
                    appState.messageStore.resolvePermissionMessage(sessionId, permissionId: perm.id, resolution: "approved")
                } else {
                    send(["type": "deny", "payload": ["permissionId": perm.id]], sessionId: sessionId)
                    appState.messageStore.removePermission(perm.id)
                    appState.messageStore.resolvePermissionMessage(sessionId, permissionId: perm.id, resolution: "denied")
                }
            }
        case .safe:
            break // No auto-resolution in safe mode
        }
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

    /// Create a new session. Returns the requestId for tracking.
    @discardableResult
    func createSession(
        targetDeviceId: String,
        model: String,
        reasoningEffort: ReasoningEffort? = nil,
        prompt: String? = nil,
        cwd: String? = nil,
        title: String? = nil
    ) -> String {
        let requestId = "req_\(Int(Date().timeIntervalSince1970 * 1000))_\(String(Int.random(in: 0...999999), radix: 36))"

        if let prompt {
            pendingCreateRequests[requestId] = prompt
        } else {
            pendingCreateRequests[requestId] = ""
        }

        if let title, !title.isEmpty {
            pendingCreateTitles[requestId] = title
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
        let requestId = "req_\(Int(Date().timeIntervalSince1970 * 1000))_\(String(Int.random(in: 0...999999), radix: 36))"
        pendingCreateRequests[requestId] = ""

        send([
            "type": "fork_session",
            "payload": ["requestId": requestId, "sourceSessionId": sessionId],
        ], sessionId: sessionId)
    }

    func deleteSession(sessionId: String) {
        guard let appState else { return }
        send(["type": "delete_session", "payload": [:] as [String: Any]], sessionId: sessionId)
        appState.sessionStore.removeSession(sessionId)
        appState.messageStore.deleteSessionMessages(sessionId)
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
        appState.sessionStore.incrementUnread(sessionId)
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

    func requestReplay(sessionId: String, afterSeq: Int, limit: Int? = nil) {
        var payload: [String: Any] = ["sessionId": sessionId, "afterSeq": afterSeq]
        if let limit { payload["limit"] = limit }
        send(["type": "request_session_replay", "payload": payload], sessionId: sessionId)
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
        if let prompt = pendingCreateRequests.removeValue(forKey: requestId) {
            // Auto-navigate to the new session
            appState.sessionStore.navigateToSession = sessionId
            // If we had a prompt, send it now
            if !prompt.isEmpty {
                sendInput(sessionId: sessionId, text: prompt)
            }
        }
    }

    func reset() {
        pendingCreateRequests.removeAll()
        pendingCreateTitles.removeAll()
        pendingModeChanges.removeAll()
    }
}
