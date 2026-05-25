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
            .sorted { sortKey($0) < sortKey($1) }
        messages[sessionId] = merged
        return merged
    }

    // MARK: - Message Operations

    /// Append a message, deduplicating by seq.
    func appendMessage(_ sessionId: String, _ message: ChatMessage) {
        // Defensive guard against the "active envelope pollution" bug
        // class: storing transient envelope types (whose `seq` field
        // comes from the relay's global event counter, not the
        // per-session conversation counter) inflates `getLastSeq` and
        // breaks `MessageProvider.requestLatest`'s short-circuit. The
        // visible symptom is "chat stops receiving messages after
        // reconnect" because the client thinks it's ahead of tentacle.
        //
        // Rule: only persistent types (with real per-session seqs) and
        // the `pending_input` optimistic placeholder (with `seq == 0`)
        // belong here.
        let isPersistent = Self.persistentTypes.contains(message.type)
        let isOptimisticPlaceholder = message.type == "pending_input" && message.seq == 0
        guard isPersistent || isOptimisticPlaceholder else {
            KLog.d("⚠️ appendMessage rejected: type=\(message.type) seq=\(message.seq) — not persistent and not a placeholder")
            return
        }
        hydrateFromDisk(sessionId)
        var list = messages[sessionId] ?? []
        // pending_input is identified by `clientId`, not `seq` (every
        // pending shares seq=0). Multiple in-flight pendings coexist
        // until each is resolved by its own ack — just append.
        if message.type == "pending_input" {
            list.append(message)
        } else if let idx = list.firstIndex(where: { $0.seq == message.seq && $0.type == message.type }) {
            // Deduplicate persistent messages by [type, seq]. Defends
            // against relay re-broadcasts (e.g. reconnect mid-batch).
            list[idx] = message
        } else {
            list.append(message)
            list.sort { sortKey($0) < sortKey($1) }
        }
        messages[sessionId] = list

        if shouldPersist(message) {
            persistentCache.appendMessage(sessionId, message)
        }
    }

    /// Sort key for chat messages. Real messages sort by seq;
    /// `pending_input` (seq=0) sorts to the very end so optimistic
    /// placeholders always appear after the latest server-acked turn.
    private func sortKey(_ msg: ChatMessage) -> Int {
        msg.type == "pending_input" ? Int.max : msg.seq
    }

    /// Prepend older messages (from replay), deduplicating by seq.
    func prependMessages(_ sessionId: String, _ older: [ChatMessage]) {
        hydrateFromDisk(sessionId)
        var existing = messages[sessionId] ?? []
        let existingSeqs = Set(existing.map(\.seq))
        let unique = older.filter { !existingSeqs.contains($0.seq) }
        guard !unique.isEmpty else { return }
        existing.append(contentsOf: unique)
        // Use sortKey so pending_input (seq=0) is pinned at the tail
        // rather than sorted before replayed history.
        existing.sort { sortKey($0) < sortKey($1) }
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
        // Find the largest seq among PERSISTENT messages only. Belt-
        // and-suspenders alongside the type guard in `appendMessage`:
        // if any non-persistent entry ever slipped past the guard
        // (legacy on-disk pollution, unforeseen path), it must not
        // raise the reported lastSeq — otherwise
        // `MessageProvider.requestLatest`'s
        // `storeLastSeq >= tentacleLastSeq` short-circuit would fire
        // spuriously and we'd permanently stop pulling new messages.
        let list = messages[sessionId] ?? []
        var best = 0
        for m in list where Self.persistentTypes.contains(m.type) && m.seq > best {
            best = m.seq
        }
        return best
    }

    /// Drop all in-memory messages for `sessionId` whose seq is
    /// strictly greater than `seq`. Used by tentacle-restart recovery
    /// in `MessageProvider.setTentacleInfo`: if the relay reports a
    /// per-session lastSeq lower than what we have, our cache holds
    /// stale messages from a previous tentacle incarnation (or
    /// polluted entries from a pre-fix build). Purging the tail lets
    /// `requestLatest` proceed instead of short-circuiting.
    func dropMessagesAboveSeq(_ sessionId: String, seq: Int) {
        guard var list = messages[sessionId], !list.isEmpty else { return }
        let before = list.count
        list.removeAll { $0.seq > seq }
        guard list.count != before else { return }
        messages[sessionId] = list
        // Also walk the disk cache so we don't re-hydrate the polluted
        // entries on the next launch.
        persistentCache.dropMessagesAboveSeq(sessionId, seq: seq)
    }

    func deleteSessionMessages(_ sessionId: String) {
        messages.removeValue(forKey: sessionId)
        hydratedSessions.remove(sessionId)
        persistentCache.deleteSession(sessionId)
        // Also clean up permissions/questions for this session
        pendingPermissions = pendingPermissions.filter { $0.value.sessionId != sessionId }
        pendingQuestions = pendingQuestions.filter { $0.value.sessionId != sessionId }
    }

    /// Replace a pending_input with a real user_message after the
    /// server confirms. Matching is by `clientId` when present, with
    /// a content-match fallback for legacy clients/tentacles. Returns
    /// `true` if a pending was resolved; the caller can then skip
    /// appending the broadcast (which would otherwise duplicate it).
    @discardableResult
    func resolvePendingInput(_ sessionId: String,
                             seq: Int,
                             clientId: String?,
                             content: String?) -> Bool {
        guard var list = messages[sessionId] else { return false }
        // Identify the right pending:
        //   1. With clientId: exact match (new clients ↔ new tentacle).
        //   2. Without clientId, with content: first pending whose
        //      local text equals the server's content. Handles
        //      "new client → old tentacle" without inappropriately
        //      claiming user_messages broadcast by other devices.
        //   3. Without either: no resolve. Caller will append.
        let idx: Int?
        if let clientId {
            idx = list.firstIndex(where: { $0.type == "pending_input" && $0.clientId == clientId })
        } else if let content {
            idx = list.firstIndex(where: { $0.type == "pending_input" && $0.content == content })
        } else {
            idx = nil
        }
        guard let idx else { return false }

        let pending = list[idx]
        var newPayload = pending.payload
        if let content { newPayload["content"] = AnyCodable(content) }
        newPayload.removeValue(forKey: "clientId")
        let resolved = ChatMessage(
            type: "user_message",
            seq: seq,
            sessionId: sessionId,
            deviceId: pending.deviceId,
            timestamp: pending.timestamp,
            payload: newPayload
        )
        list[idx] = resolved
        // Re-sort: the resolved message got its server seq and should
        // slot into position relative to other persistent messages.
        // Remaining pendings (still seq=0) stay at the tail thanks to
        // `sortKey`.
        list.sort { sortKey($0) < sortKey($1) }
        messages[sessionId] = list

        // Persist the resolved user_message. Without this, iOS-sent
        // user_messages live only in memory and silently disappear
        // from the on-disk cache across app restarts (we'd hydrate
        // back into a session whose user-side is missing the turn we
        // just sent).
        if shouldPersist(resolved) {
            persistentCache.appendMessage(sessionId, resolved)
        }
        return true
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
