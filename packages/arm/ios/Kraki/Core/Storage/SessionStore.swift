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
    /// Name of the tool currently in flight in this session's latest turn
    /// (last `tool_start` without a matching `tool_complete`). Drives the
    /// per-session activity icon on `AgentAvatar`. Cleared on `idle` or
    /// once the matching `tool_complete` arrives.
    var currentToolName: String?
    /// Short user-facing preview of the in-flight tool (the `headline`
    /// field of `tool_start`). Used to fill the activity row on the
    /// session card.
    var currentToolHeadline: String?
    /// Latest activity snapshot used to populate the session-card
    /// "active" row. Cleared to `.none` on idle.
    var activity: SessionActivity = .none

    var displayTitle: String { title ?? autoTitle ?? "New Session" }
}

/// Coarse-grained "what is this session doing right now?" enum that
/// drives the at-a-glance activity row on the session card. Mirrors
/// the chronologically-latest event the agent emitted.
enum SessionActivity: Equatable {
    case none
    /// Tool currently in flight. `toolName` chooses the icon; `headline`
    /// fills the label (e.g. `$ npm test`).
    case toolRunning(toolName: String, headline: String?)
    /// Most recent tool finished but no agent text has arrived after it
    /// (intermediate state during multi-tool turns). `success == false`
    /// renders a red ✗ corner badge; anything else renders a green ✓.
    case toolComplete(toolName: String, headline: String?, success: Bool?)
    /// Agent is producing free-form text (final message or in-progress
    /// delta). Icon is the keyboard glyph.
    case agentText(String)
}

// MARK: - SessionStore

@Observable
final class SessionStore {
    var sessions: [String: SessionInfo] = [:]
    var activeSessionId: String?
    var pinnedSessions: Set<String> = []
    var sessionModes: [String: SessionMode] = [:]
    var sessionUsage: [String: SessionUsage] = [:]
    var sessionPreviews: [String: SessionPreview] = [:]
    var drafts: [String: String] = [:]
    var navigateToSession: String?
    var streamingContent: [String: String] = [:]

    /// Sessions for which a `create_session` / `fork_session` /
    /// `import_session` has been sent but no `session_created` has
    /// arrived yet. Used to render an optimistic "Starting session…"
    /// placeholder in `SessionDetailView` while waiting. Mirrors the
    /// web client's `pendingSessions` Set on the store.
    ///
    /// For `import_session` the entry is the future session id (which
    /// equals the localSessionId). For `create_session` / `fork_session`
    /// the entry is a client-generated UUID placeholder, swapped out
    /// for the real id once `session_created` arrives.
    var pendingSessions: Set<String> = []

    /// Optional human-readable error message attached to a pending
    /// session when its server-side creation failed. The placeholder
    /// view renders this string in the error state.
    var pendingSessionErrors: [String: String] = [:]

    /// Snapshot of "was this session unread when we opened it?",
    /// captured synchronously by `SessionDetailView` before it
    /// schedules markRead. Lets `ChatView`'s R3 entry-scroll branch
    /// on the original unread state even though markRead runs first.
    /// ChatView consumes (and clears) the entry it owns at the start
    /// of `performEntryScroll`.
    var entryUnreadSnapshots: [String: Bool] = [:]

    /// Sessions currently fetching messages from tentacle (per-session
    /// in-flight set). Maintained by MessageProvider; views read it to
    /// show loading affordances (e.g. ChatView's State-A center
    /// spinner, State-B top spinner).
    var loadingSessions: Set<String> = []

    func setLoading(_ id: String, _ loading: Bool) {
        if loading { loadingSessions.insert(id) }
        else { loadingSessions.remove(id) }
    }

    func isLoading(_ id: String) -> Bool {
        loadingSessions.contains(id)
    }

    // MARK: - Computed unread (seq-derived)

    /// Per-session unread count, derived from `lastSeq − readSeq`.
    /// Mirrors the WhatsApp / Telegram / Slack model: there is no
    /// separate counter to drift out of sync; `lastSeq` and `readSeq`
    /// are both monotonic and authoritative.
    func unreadCount(_ id: String) -> Int {
        guard let s = sessions[id] else { return 0 }
        return max(0, s.lastSeq - s.readSeq)
    }

    /// Convenience boolean for badge-style consumers (red dot).
    func isUnread(_ id: String) -> Bool {
        unreadCount(id) > 0
    }

    // MARK: - Computed

    /// Sessions sorted: pinned first, then by effective timestamp
    /// descending (latest preview if any, else session.createdAt),
    /// then by createdAt as a final tiebreaker. The fallback to
    /// createdAt for sessions without a live preview keeps freshly-
    /// created or freshly-imported sessions at the top after a cold
    /// relaunch, when their in-memory preview entry hasn't been
    /// seeded yet.
    var sortedSessions: [SessionInfo] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func effectiveTs(_ s: SessionInfo) -> String {
            if let t = sessionPreviews[s.id]?.timestamp, !t.isEmpty { return t }
            return iso.string(from: s.createdAt)
        }
        return sessions.values.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            let aTs = effectiveTs(a)
            let bTs = effectiveTs(b)
            if aTs != bTs { return bTs < aTs }
            return a.createdAt > b.createdAt
        }
    }

    var totalUnread: Int {
        sessions.values.reduce(0) { $0 + max(0, $1.lastSeq - $1.readSeq) }
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
            // Monotonic: never let a digest pull our seqs backward.
            // This is the standard cross-device pattern — both
            // counters move forward only, and unread = max(0, last - read).
            existing.lastSeq = max(existing.lastSeq, digest.lastSeq)
            existing.readSeq = max(existing.readSeq, digest.readSeq)
            // Defense in depth: clamp readSeq to lastSeq. A readSeq
            // greater than lastSeq is logically impossible (you can't
            // have read past the last known message) and indicates
            // upstream pollution — e.g. an earlier client bug that
            // sent a mark_read using a transient envelope seq from a
            // different counter, which tentacle then persisted. The
            // clamp guarantees the badge can still light up when a
            // fresh per-session seq comes in.
            existing.readSeq = min(existing.readSeq, existing.lastSeq)
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
                readSeq: min(digest.readSeq, digest.lastSeq),
                messageCount: digest.messageCount,
                createdAt: date,
                usage: digest.usage,
                pinned: pinned,
                currentToolName: nil,
                currentToolHeadline: nil
            )
        }

        sessionModes[digest.id] = mode
        if let usage = digest.usage {
            sessionUsage[digest.id] = usage
        }
        if pinned {
            pinnedSessions.insert(digest.id)
        }
        // Unread is computed on demand from lastSeq − readSeq; no
        // separate state to seed here.
    }

    func removeSession(_ id: String) {
        sessions.removeValue(forKey: id)
        pinnedSessions.remove(id)
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
        // Idle clears any lingering tool-in-flight marker AND the
        // activity snapshot — at idle, the session-card row falls back
        // to the standard preview / draft rendering.
        if state == .idle {
            sessions[id]?.currentToolName = nil
            sessions[id]?.currentToolHeadline = nil
            sessions[id]?.activity = .none
        }
    }

    /// Record the tool whose `tool_start` event just arrived. The icon
    /// (and headline) is later cleared by either the matching
    /// `tool_complete` (handled in `clearCurrentTool`) or an `idle`
    /// transition. Also bumps the activity snapshot to `.toolRunning`.
    func setCurrentTool(_ id: String, toolName: String, headline: String? = nil) {
        sessions[id]?.currentToolName = toolName
        sessions[id]?.currentToolHeadline = headline
        sessions[id]?.activity = .toolRunning(toolName: toolName, headline: headline)
    }

    /// Clear the current tool indicator. Called on `tool_complete` when
    /// the completing call matches the active tool, and on session
    /// teardown / idle. Bumps activity snapshot to `.toolComplete` so
    /// the icon shows a success/failure badge until something else
    /// displaces it.
    func clearCurrentTool(_ id: String, ifMatching toolName: String? = nil, success: Bool? = nil) {
        guard var info = sessions[id] else { return }
        if let toolName, info.currentToolName != toolName { return }
        // Capture the tool we're clearing so the success/failure-icon
        // state can reference it.
        let completedName = info.currentToolName
        let completedHeadline = info.currentToolHeadline
        info.currentToolName = nil
        info.currentToolHeadline = nil
        if let name = completedName {
            info.activity = .toolComplete(toolName: name, headline: completedHeadline, success: success)
        }
        sessions[id] = info
    }

    /// Update the activity snapshot to "agent producing text". Called on
    /// `agent_message` (final) and `agent_message_delta` events.
    func setAgentTextActivity(_ id: String, text: String) {
        guard !text.isEmpty else { return }
        // Only meaningful while the session is active; if the message
        // was already idle-flushed, don't resurrect a stale activity row.
        guard sessions[id]?.state == .active else { return }
        sessions[id]?.activity = .agentText(text)
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

    // MARK: - Read / unread (seq-derived)

    /// Move a session's `readSeq` forward. Monotonic — never moves
    /// backward, so out-of-order `session_read` echoes from the
    /// server / other devices are safe. Local "mark as read" calls
    /// from this device also pass through here.
    ///
    /// Additionally clamps `readSeq` to `lastSeq` — a readSeq greater
    /// than lastSeq is logically impossible and indicates upstream
    /// pollution (see the same defense in `upsertSession`).
    func markRead(_ id: String, seq: Int) {
        guard var s = sessions[id] else { return }
        let clamped = min(seq, s.lastSeq)
        if clamped > s.readSeq {
            s.readSeq = clamped
            sessions[id] = s
        }
    }

    /// Move a session's `lastSeq` forward when a new message has been
    /// observed. Monotonic — never moves backward. Called from the
    /// message router on every inbound producer envelope that carries
    /// a `seq`. The unread count is `lastSeq − readSeq`, so advancing
    /// `lastSeq` is what makes a session light up as unread.
    func bumpLastSeq(_ id: String, seq: Int) {
        guard var s = sessions[id] else { return }
        if seq > s.lastSeq {
            s.lastSeq = seq
            sessions[id] = s
        }
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
        sessionModes.removeAll()
        sessionUsage.removeAll()
        sessionPreviews.removeAll()
        drafts.removeAll()
        navigateToSession = nil
        streamingContent.removeAll()
        loadingSessions.removeAll()
        entryUnreadSnapshots.removeAll()
    }

    // MARK: - Convenience Methods (called by MessageRouter)

    /// Look up a session by ID (alias for sessions[id]).
    func session(for id: String) -> SessionInfo? {
        sessions[id]
    }

    // MARK: - Pending sessions (optimistic UI)

    /// Mark a session id as pending. The placeholder id is used as a
    /// navigation token by `SessionDetailView` while the real session
    /// is being created server-side.
    func addPendingSession(_ id: String) {
        pendingSessions.insert(id)
        pendingSessionErrors.removeValue(forKey: id)
    }

    /// Clear a pending entry without affecting any real session that
    /// has since been added under the same id.
    func removePendingSession(_ id: String) {
        pendingSessions.remove(id)
        pendingSessionErrors.removeValue(forKey: id)
    }

    /// Record a server-side error reason for a pending session so the
    /// placeholder view can render a friendly error state.
    func setPendingError(_ id: String, reason: String) {
        guard pendingSessions.contains(id) else { return }
        pendingSessionErrors[id] = reason
    }

    func isPending(_ id: String) -> Bool {
        pendingSessions.contains(id)
    }

    /// Update session state from a string value.
    func updateState(_ id: String, state: String) {
        if let s = SessionState(rawValue: state) {
            setState(id, s)
        } else if state == "ended" {
            setState(id, .idle)
        }
    }

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
        let contextTokens = usage["contextTokens"] as? Int
        let parsed = SessionUsage(
            inputTokens: input, outputTokens: output,
            cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
            totalCost: cost, totalDurationMs: duration,
            contextTokens: contextTokens
        )
        setUsage(id, parsed)
    }

    /// Set session preview text — pure data plumbing. Unread is now
    /// derived from `lastSeq − readSeq` and lives entirely in the
    /// seq pipeline (see `bumpLastSeq` / `markRead`), so preview
    /// updates no longer carry an unread side-effect.
    func setSessionPreview(
        _ id: String,
        text: String,
        type: String,
        timestamp: String?
    ) {
        setPreview(id, text: text, type: type, timestamp: timestamp ?? "")
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
