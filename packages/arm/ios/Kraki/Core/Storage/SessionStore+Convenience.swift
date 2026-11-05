import Foundation

// Moved out of SessionStore.swift (file and type length): seq-derived unread,
// the legacy test surface, aliases the router calls and the optimistic
// placeholder bookkeeping.
extension SessionStore {
    // MARK: - Computed unread (seq-derived)

    /// Session-level unread indicator. The cursor gap is intentionally not a
    /// message count: Tentacle owns both cursors and Clients project one dot.
    func unreadCount(_ id: String) -> Int {
        guard let s = sessions[id] else { return 0 }
        return s.readSeq < s.lastSeq ? 1 : 0
    }

    /// Convenience boolean for badge-style consumers (red dot).
    func isUnread(_ id: String) -> Bool {
        unreadCount(id) > 0
    }

    // MARK: - Test-Compat Shims
    //
    // Earlier versions of the store kept an explicit counter-based
    // unread map (`unreadCounts`) and helpers like `incrementUnread`
    // / `clearUnread`. The seq-based model replaced those, but the
    // existing `SessionStoreTests` suite still drives the legacy
    // surface. We keep these shims so the test suite stays
    // authoritative without rewriting every test, while production
    // code continues to use the seq-based API directly.

    /// Compatibility map for callers that still consume count-shaped state.
    /// Values remain boolean-shaped to match the product contract.
    var unreadCounts: [String: Int] {
        Dictionary(uniqueKeysWithValues: sessions.keys.compactMap { id in
            let count = unreadCount(id)
            return count > 0 ? (id, count) : nil
        })
    }

    /// Simulate "a new message arrived" by bumping `lastSeq` on the
    /// session. Mirrors what an incoming router event would do.
    func incrementUnread(_ id: String) {
        guard var s = sessions[id] else { return }
        s.lastSeq += 1
        sessions[id] = s
    }

    /// Mark every message read up to `lastSeq`.
    func clearUnread(_ id: String) {
        guard var s = sessions[id] else { return }
        s.readSeq = s.lastSeq
        sessions[id] = s
    }

    /// Update the session's display title (preserves the legacy
    /// setter name used by tests; production code uses
    /// `upsertSession` with a new digest). The `autoTitle` flag is
    /// honored by routing the title into `autoTitle` instead of
    /// `title` when the caller is signalling a tentacle-generated
    /// name.
    func setSessionTitle(_ id: String, title: String, autoTitle: Bool = false) {
        guard var s = sessions[id] else { return }
        if autoTitle {
            s.autoTitle = title
        } else {
            s.title = title
        }
        sessions[id] = s
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
        pendingSessionTitles.removeValue(forKey: id)
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
    func setSessionModel(
        _ id: String,
        model: String,
        reasoningEffort: ReasoningEffort? = nil
    ) {
        setModel(id, model, reasoningEffort: reasoningEffort)
    }

    /// Set session pinned state (alias).
    func setSessionPinned(_ id: String, pinned: Bool) {
        setPinned(id, pinned)
    }

    /// Apply Tentacle's authoritative session_read cursor (alias).
    func setSessionReadSeq(_ id: String, seq: Int) {
        applyAuthoritativeReadSeq(id, seq: seq)
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

    /// Set session preview text — pure data plumbing. Unread lives on
    /// Tentacle's authoritative cursor pair, so preview has no side effect.
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
        scheduleSave()
    }

    /// Sync sessions from a parsed session list.
    func syncSessions(_ summaries: [SessionDigest], deviceId: String = "", deviceName: String = "") {
        reconcileSessionList(summaries, deviceId: deviceId, deviceName: deviceName)
    }
}
