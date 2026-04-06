/// MessageStore — In-memory message cache with pending permission/question tracking.
///
/// Mirrors the message slice of useStore.ts. Messages are stored per session,
/// deduplicated by seq, and sorted ascending. Pending permissions and questions
/// are tracked separately for quick lookup by the UI.

import Foundation
import Observation

// ChatMessage, PendingPermission, and PendingQuestion are defined in
// Core/Protocol/Messages.swift — the canonical definitions.

// MARK: - MessageStore

@Observable
final class MessageStore {
    /// sessionId → sorted messages (ascending by seq)
    var messages: [String: [ChatMessage]] = [:]
    /// permissionId → pending permission
    var pendingPermissions: [String: PendingPermission] = [:]
    /// questionId → pending question
    var pendingQuestions: [String: PendingQuestion] = [:]

    // MARK: - Message Operations

    /// Append a message, deduplicating by seq.
    func appendMessage(_ sessionId: String, _ message: ChatMessage) {
        var list = messages[sessionId] ?? []
        // Deduplicate: replace existing message with same seq, or append
        if let idx = list.firstIndex(where: { $0.seq == message.seq }) {
            list[idx] = message
        } else {
            list.append(message)
            list.sort { $0.seq < $1.seq }
        }
        messages[sessionId] = list
    }

    /// Prepend older messages (from replay), deduplicating by seq.
    func prependMessages(_ sessionId: String, _ older: [ChatMessage]) {
        var existing = messages[sessionId] ?? []
        let existingSeqs = Set(existing.map(\.seq))
        let unique = older.filter { !existingSeqs.contains($0.seq) }
        guard !unique.isEmpty else { return }
        existing.append(contentsOf: unique)
        existing.sort { $0.seq < $1.seq }
        messages[sessionId] = existing
    }

    func getMessages(_ sessionId: String) -> [ChatMessage] {
        messages[sessionId] ?? []
    }

    func getLastSeq(_ sessionId: String) -> Int {
        messages[sessionId]?.last?.seq ?? 0
    }

    func deleteSessionMessages(_ sessionId: String) {
        messages.removeValue(forKey: sessionId)
        // Also clean up permissions/questions for this session
        pendingPermissions = pendingPermissions.filter { $0.value.sessionId != sessionId }
        pendingQuestions = pendingQuestions.filter { $0.value.sessionId != sessionId }
    }

    /// Replace pending_input with a real user_message after server confirms.
    func resolvePendingInput(_ sessionId: String, seq: Int, content: String) {
        guard var list = messages[sessionId] else { return }
        guard let idx = list.firstIndex(where: { $0.type == "pending_input" }) else { return }

        let pending = list[idx]
        let resolved = ChatMessage(
            type: "user_message",
            seq: seq,
            sessionId: sessionId,
            deviceId: "",
            timestamp: pending.timestamp,
            payload: pending.payload
        )
        list[idx] = resolved
        messages[sessionId] = list
    }

    /// Stamp a resolution on the matching permission message in the message list.
    func resolvePermissionMessage(_ sessionId: String, permissionId: String, resolution: String) {
        guard var list = messages[sessionId] else { return }
        for i in stride(from: list.count - 1, through: 0, by: -1) {
            let m = list[i]
            if m.type == "permission" && m.permissionId == permissionId {
                var updated = m
                updated.payload["resolution"] = AnyCodable(resolution)
                list[i] = updated
                messages[sessionId] = list
                return
            }
        }
    }

    /// Stamp an answer on the matching question message in the message list.
    func resolveQuestionMessage(_ sessionId: String, questionId: String, answerText: String) {
        guard var list = messages[sessionId] else { return }
        for i in stride(from: list.count - 1, through: 0, by: -1) {
            let m = list[i]
            if m.type == "question" && m.questionId == questionId {
                var updated = m
                updated.payload["answer"] = AnyCodable(answerText)
                list[i] = updated
                messages[sessionId] = list
                return
            }
        }
    }

    // MARK: - Pending Permission Operations

    func addPermission(_ permission: PendingPermission) {
        pendingPermissions[permission.id] = permission
    }

    func removePermission(_ id: String) {
        pendingPermissions.removeValue(forKey: id)
    }

    func permissionsForSession(_ sessionId: String) -> [PendingPermission] {
        pendingPermissions.values.filter { $0.sessionId == sessionId }
    }

    // MARK: - Pending Question Operations

    func addQuestion(_ question: PendingQuestion) {
        pendingQuestions[question.id] = question
    }

    func removeQuestion(_ id: String) {
        pendingQuestions.removeValue(forKey: id)
    }

    func questionsForSession(_ sessionId: String) -> [PendingQuestion] {
        pendingQuestions.values.filter { $0.sessionId == sessionId }
    }

    // MARK: - Reset

    func clearTransientState() {
        pendingPermissions.removeAll()
        pendingQuestions.removeAll()
        // Remove pending_input messages (stale optimistic inserts)
        for (sessionId, var list) in messages {
            let before = list.count
            list.removeAll { $0.type == "pending_input" }
            if list.count != before {
                messages[sessionId] = list
            }
        }
    }

    func reset() {
        messages.removeAll()
        pendingPermissions.removeAll()
        pendingQuestions.removeAll()
    }

    // MARK: - Convenience Methods (called by MessageRouter)

    /// Append a message decoded from raw JSON data.
    func appendMessage(_ sessionId: String, json: Data) {
        guard let dict = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let msg = ProducerMessageDecoder.decode(json) else { return }
        _ = dict // suppress unused warning
        appendMessage(sessionId, msg)
    }

    /// Resolve pending input by seq only (content comes from the existing pending message).
    func resolvePendingInput(_ sessionId: String, seq: Int) {
        guard let list = messages[sessionId],
              let pending = list.first(where: { $0.type == "pending_input" }) else { return }
        resolvePendingInput(sessionId, seq: seq, content: pending.content ?? "")
    }

    /// Check if a session has any pending_input messages.
    func hasPendingInput(_ sessionId: String) -> Bool {
        messages[sessionId]?.contains(where: { $0.type == "pending_input" }) ?? false
    }

    /// Get the content of the last agent_message for a session.
    func lastAgentMessageContent(_ sessionId: String) -> String? {
        guard let list = messages[sessionId] else { return nil }
        return list.last(where: { $0.type == "agent_message" })?.content
    }

    /// Resolve a question with an optional answer string.
    func resolveQuestionMessage(_ sessionId: String, questionId: String, answer: String?) {
        resolveQuestionMessage(sessionId, questionId: questionId, answerText: answer ?? "")
    }
}
