/// MessageStore — In-memory message cache with pending permission/question tracking.
///
/// Mirrors the message slice of useStore.ts. Messages are stored per session,
/// deduplicated by seq, and sorted ascending. Pending permissions and questions
/// are tracked separately for quick lookup by the UI.
///
/// In v0.17+ the store is backed by `PersistentMessageCache` so the
/// in-memory list survives cold launches and the warm-up path can ask
/// "what's the highest seq I already have?" without a tentacle replay.
/// Only the canonical content-stream types are persisted (see
/// `Self.persistentTypes`).

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

    /// Disk-backed cache. Writes happen as a side effect of
    /// `appendMessage` / `prependMessages`; reads are used by the
    /// warm-up classifier and the unread-worthy filter.
    let persistentCache = PersistentMessageCache()

    /// Sessions whose persisted history has been hydrated into
    /// `messages` since process launch. Hydration is lazy — a session
    /// is only loaded when something asks for it (session opens,
    /// preview rebuild, etc.) so launch isn't blocked by O(allSessions)
    /// disk reads.
    private var hydratedSessions: Set<String> = []

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

    // MARK: - Hydration

    /// Pull a session's persisted history into the in-memory store on
    /// demand. Safe to call repeatedly — only the first call per
    /// session per launch does disk I/O.
    @discardableResult
    func hydrateFromDisk(_ sessionId: String) -> [ChatMessage] {
        if hydratedSessions.contains(sessionId) { return messages[sessionId] ?? [] }
        hydratedSessions.insert(sessionId)
        let persisted = persistentCache.getMessages(sessionId)
        guard !persisted.isEmpty else { return [] }
        // Merge with any in-memory messages that arrived first (rare —
        // hydration usually happens before live messages for a given
        // session, but defend against ordering anyway).
        let existing = messages[sessionId] ?? []
        let existingSeqs = Set(existing.map(\.seq))
        let merged = (existing + persisted.filter { !existingSeqs.contains($0.seq) })
            .sorted { $0.seq < $1.seq }
        messages[sessionId] = merged
        return merged
    }

    // MARK: - Message Operations

    /// Append a message, deduplicating by seq.
    func appendMessage(_ sessionId: String, _ message: ChatMessage) {
        hydrateFromDisk(sessionId)
        var list = messages[sessionId] ?? []
        // Deduplicate: replace existing message with same seq, or append
        if let idx = list.firstIndex(where: { $0.seq == message.seq }) {
            list[idx] = message
        } else {
            list.append(message)
            list.sort { $0.seq < $1.seq }
        }
        messages[sessionId] = list

        if shouldPersist(message) {
            persistentCache.appendMessage(sessionId, message)
        }
    }

    /// Prepend older messages (from replay), deduplicating by seq.
    func prependMessages(_ sessionId: String, _ older: [ChatMessage]) {
        hydrateFromDisk(sessionId)
        var existing = messages[sessionId] ?? []
        let existingSeqs = Set(existing.map(\.seq))
        let unique = older.filter { !existingSeqs.contains($0.seq) }
        guard !unique.isEmpty else { return }
        existing.append(contentsOf: unique)
        existing.sort { $0.seq < $1.seq }
        messages[sessionId] = existing

        let toPersist = unique.filter(shouldPersist)
        if !toPersist.isEmpty {
            persistentCache.appendMessages(sessionId, toPersist)
        }
    }

    private func shouldPersist(_ msg: ChatMessage) -> Bool {
        msg.seq > 0 && Self.persistentTypes.contains(msg.type)
    }

    func getMessages(_ sessionId: String) -> [ChatMessage] {
        hydrateFromDisk(sessionId)
        return messages[sessionId] ?? []
    }

    func getLastSeq(_ sessionId: String) -> Int {
        hydrateFromDisk(sessionId)
        return messages[sessionId]?.last?.seq ?? 0
    }

    func deleteSessionMessages(_ sessionId: String) {
        messages.removeValue(forKey: sessionId)
        hydratedSessions.remove(sessionId)
        persistentCache.deleteSession(sessionId)
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

        // Persist the resolved user_message. Without this, iOS-sent
        // user_messages live only in memory and silently disappear
        // from the on-disk cache across app restarts (we'd hydrate
        // back into a session whose user-side is missing the turn we
        // just sent).
        if shouldPersist(resolved) {
            persistentCache.appendMessage(sessionId, resolved)
        }
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
        hydratedSessions.removeAll()
        pendingPermissions.removeAll()
        pendingQuestions.removeAll()
        persistentCache.deleteAll()
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

    /// Get the content of the last user_message for a session. Used by
    /// the session-card activity row to surface the prompt that
    /// kicked off the current turn (replaces the generic "Thinking…").
    func lastUserMessageContent(_ sessionId: String) -> String? {
        guard let list = messages[sessionId] else { return nil }
        return list.last(where: { $0.type == "user_message" })?.content
    }

    /// Resolve a question with an optional answer string.
    func resolveQuestionMessage(_ sessionId: String, questionId: String, answer: String?) {
        resolveQuestionMessage(sessionId, questionId: questionId, answerText: answer ?? "")
    }
}
