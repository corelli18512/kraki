/// SessionStore — Observable session state, mirroring useStore.ts session fields.
///
/// Maintains all known sessions, pinned state, unread counts, modes,
/// usage, previews, drafts, and streaming deltas.

import Foundation
import Observation

// MARK: - SessionInfo

struct SessionInfo: Identifiable, Equatable {
    let id: String
    var deviceId: String
    var deviceName: String
    var agent: String
    var model: String?
    var title: String?
    var autoTitle: String?
    var state: SessionState
    var mode: SessionMode
    var lastSeq: Int
    var readSeq: Int
    var messageCount: Int
    var createdAt: Date
    var usage: SessionUsage?
    var pinned: Bool

    var displayTitle: String { title ?? autoTitle ?? "New Session" }
}

// MARK: - SessionStore

@Observable
final class SessionStore {
    var sessions: [String: SessionInfo] = [:]
    var activeSessionId: String?
    var pinnedSessions: Set<String> = []
    var unreadCounts: [String: Int] = [:]
    var sessionModes: [String: SessionMode] = [:]
    var sessionUsage: [String: SessionUsage] = [:]
    var sessionPreviews: [String: SessionPreview] = [:]
    var drafts: [String: String] = [:]
    var navigateToSession: String?
    var streamingContent: [String: String] = [:]

    // MARK: - Computed

    /// Sessions sorted: pinned first, then by preview timestamp descending,
    /// then by createdAt. Pinned items float to the top in a single flat list
    /// (no section header — pin status is shown as an inline badge).
    var sortedSessions: [SessionInfo] {
        sessions.values.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            let aTs = sessionPreviews[a.id]?.timestamp ?? ""
            let bTs = sessionPreviews[b.id]?.timestamp ?? ""
            if aTs != bTs { return bTs < aTs }
            return a.createdAt > b.createdAt
        }
    }

    var totalUnread: Int {
        unreadCounts.values.reduce(0, +)
    }

    // MARK: - Session CRUD

    func upsertSession(_ digest: SessionDigest, deviceId: String, deviceName: String) {
        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = dateFormatter.date(from: digest.createdAt) ?? Date()

        let mode = digest.mode
        let pinned = digest.pinned ?? pinnedSessions.contains(digest.id)

        if var existing = sessions[digest.id] {
            existing.deviceId = deviceId
            existing.deviceName = deviceName
            existing.agent = digest.agent
            existing.model = digest.model
            existing.title = digest.title
            existing.autoTitle = digest.autoTitle
            existing.state = digest.state
            existing.mode = mode
            existing.lastSeq = digest.lastSeq
            existing.readSeq = digest.readSeq
            existing.messageCount = digest.messageCount
            existing.usage = digest.usage
            existing.pinned = pinned
            sessions[digest.id] = existing
        } else {
            sessions[digest.id] = SessionInfo(
                id: digest.id,
                deviceId: deviceId,
                deviceName: deviceName,
                agent: digest.agent,
                model: digest.model,
                title: digest.title,
                autoTitle: digest.autoTitle,
                state: digest.state,
                mode: mode,
                lastSeq: digest.lastSeq,
                readSeq: digest.readSeq,
                messageCount: digest.messageCount,
                createdAt: date,
                usage: digest.usage,
                pinned: pinned
            )
        }

        sessionModes[digest.id] = mode
        if let usage = digest.usage {
            sessionUsage[digest.id] = usage
        }
        if pinned {
            pinnedSessions.insert(digest.id)
        }

        // Reconcile unread from readSeq vs lastSeq
        if digest.lastSeq > digest.readSeq {
            let count = digest.lastSeq - digest.readSeq
            if unreadCounts[digest.id] == nil || unreadCounts[digest.id]! < count {
                unreadCounts[digest.id] = count
            }
        }
    }

    func removeSession(_ id: String) {
        sessions.removeValue(forKey: id)
        pinnedSessions.remove(id)
        unreadCounts.removeValue(forKey: id)
        sessionModes.removeValue(forKey: id)
        sessionUsage.removeValue(forKey: id)
        sessionPreviews.removeValue(forKey: id)
        drafts.removeValue(forKey: id)
        streamingContent.removeValue(forKey: id)
    }

    // MARK: - Session Properties

    func setMode(_ id: String, _ mode: SessionMode) {
        sessionModes[id] = mode
        sessions[id]?.mode = mode
    }

    func setModel(_ id: String, _ model: String) {
        sessions[id]?.model = model
    }

    func setTitle(_ id: String, title: String?, autoTitle: String?) {
        if let title { sessions[id]?.title = title.isEmpty ? nil : title }
        if let autoTitle { sessions[id]?.autoTitle = autoTitle.isEmpty ? nil : autoTitle }
    }

    func setState(_ id: String, _ state: SessionState) {
        sessions[id]?.state = state
    }

    func setUsage(_ id: String, _ usage: SessionUsage) {
        sessionUsage[id] = usage
        sessions[id]?.usage = usage
    }

    // MARK: - Pin

    func setPinned(_ id: String, _ pinned: Bool) {
        sessions[id]?.pinned = pinned
        if pinned {
            pinnedSessions.insert(id)
        } else {
            pinnedSessions.remove(id)
        }
    }

    // MARK: - Unread

    func markRead(_ id: String, seq: Int) {
        sessions[id]?.readSeq = seq
        unreadCounts.removeValue(forKey: id)
    }

    func incrementUnread(_ id: String) {
        unreadCounts[id, default: 0] += 1
    }

    func clearUnread(_ id: String) {
        unreadCounts.removeValue(forKey: id)
    }

    // MARK: - Preview / Draft

    func setPreview(_ id: String, text: String, type: String = "message", timestamp: String = "") {
        sessionPreviews[id] = SessionPreview(text: text, type: type, timestamp: timestamp)
    }

    func setDraft(_ id: String, _ text: String) {
        if text.isEmpty {
            drafts.removeValue(forKey: id)
        } else {
            drafts[id] = text
        }
    }

    // MARK: - Streaming Deltas

    func appendDelta(_ id: String, _ content: String) {
        streamingContent[id, default: ""] += content
    }

    /// Flush and return accumulated delta content, or nil if none.
    @discardableResult
    func flushDelta(_ id: String) -> String? {
        streamingContent.removeValue(forKey: id)
    }

    // MARK: - Reset

    func clearTransientState() {
        streamingContent.removeAll()
        sessionUsage.removeAll()
    }

    func reset() {
        sessions.removeAll()
        activeSessionId = nil
        pinnedSessions.removeAll()
        unreadCounts.removeAll()
        sessionModes.removeAll()
        sessionUsage.removeAll()
        sessionPreviews.removeAll()
        drafts.removeAll()
        navigateToSession = nil
        streamingContent.removeAll()
    }

    // MARK: - Convenience Methods (called by MessageRouter)

    /// Look up a session by ID (alias for sessions[id]).
    func session(for id: String) -> SessionInfo? {
        sessions[id]
    }

    /// Update session state from a string value.
    func updateState(_ id: String, state: String) {
        if let s = SessionState(rawValue: state) {
            setState(id, s)
        } else if state == "ended" {
            setState(id, .idle)
        }
    }

    /// Add a pending permission to the message store via this convenience method.
    func addPermission(
        id: String,
        sessionId: String,
        toolName: String,
        args: [String: Any],
        description: String?,
        timestamp: String?
    ) {
        // Permissions are stored on MessageStore, but this is a routing convenience.
        // Not implemented here — caller should use MessageStore directly.
    }

    /// Remove a pending permission (no-op on SessionStore, permissions live on MessageStore).
    func removePermission(_ id: String) {}

    /// Add a pending question (no-op on SessionStore, questions live on MessageStore).
    func addQuestion(
        id: String,
        sessionId: String,
        question: String,
        choices: [String]?,
        timestamp: String?
    ) {}

    /// Remove a pending question (no-op on SessionStore, questions live on MessageStore).
    func removeQuestion(_ id: String) {}

    /// Set session mode from a string value.
    func setSessionMode(_ id: String, mode: String) {
        guard let m = SessionMode(rawValue: mode) else { return }
        setMode(id, m)
    }

    /// Set session model (alias).
    func setSessionModel(_ id: String, model: String) {
        setModel(id, model)
    }

    /// Set session pinned state (alias).
    func setSessionPinned(_ id: String, pinned: Bool) {
        setPinned(id, pinned)
    }

    /// Set session read seq (alias).
    func setSessionReadSeq(_ id: String, seq: Int) {
        markRead(id, seq: seq)
    }

    /// Set session usage from a raw dictionary.
    func setSessionUsage(_ id: String, usage: [String: Any]) {
        let input = usage["inputTokens"] as? Int ?? 0
        let output = usage["outputTokens"] as? Int ?? 0
        let cacheRead = usage["cacheReadTokens"] as? Int ?? 0
        let cacheWrite = usage["cacheWriteTokens"] as? Int ?? 0
        let cost = usage["totalCost"] as? Double ?? 0
        let duration = usage["totalDurationMs"] as? Double ?? 0
        let parsed = SessionUsage(
            inputTokens: input, outputTokens: output,
            cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
            totalCost: cost, totalDurationMs: duration
        )
        setUsage(id, parsed)
    }

    /// Set session preview with optional unread increment.
    func setSessionPreview(
        _ id: String,
        text: String,
        type: String,
        timestamp: String?,
        incrementUnread: Bool = false
    ) {
        setPreview(id, text: text, type: type, timestamp: timestamp ?? "")
        if incrementUnread {
            self.incrementUnread(id)
        }
    }

    /// Upsert a SessionInfo directly (used by handleSessionCreated).
    func upsertSession(_ session: SessionInfo) {
        sessions[session.id] = session
        sessionModes[session.id] = session.mode
        if let usage = session.usage {
            sessionUsage[session.id] = usage
        }
        if session.pinned {
            pinnedSessions.insert(session.id)
        }
    }

    /// Sync sessions from a parsed session list.
    func syncSessions(_ summaries: [SessionDigest], deviceId: String = "", deviceName: String = "") {
        for digest in summaries {
            upsertSession(digest, deviceId: deviceId, deviceName: deviceName)
        }
    }
}
