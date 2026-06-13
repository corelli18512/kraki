/// SessionStore — Observable session state, mirroring useStore.ts session fields.
///
/// Maintains all known sessions, pinned state, unread counts, modes,
/// usage, previews, drafts, and streaming deltas.

import Foundation
import Observation

// MARK: - SessionInfo

struct SessionInfo: Identifiable, Equatable, Codable {
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

    // MARK: - Codable
    //
    // SessionStore's on-disk snapshot uses these keys. Transient
    // fields (`activity`, `currentToolName`, `currentToolHeadline`)
    // are intentionally omitted — on cold launch the "what's running
    // now" state is stale and gets refilled by the live message
    // stream.

    private enum CodingKeys: String, CodingKey {
        case id, deviceId, deviceName, agent, model, title, autoTitle
        case state, mode, lastSeq, readSeq, messageCount, createdAt, usage, pinned
    }

    init(
        id: String,
        deviceId: String,
        deviceName: String,
        agent: String,
        model: String? = nil,
        title: String? = nil,
        autoTitle: String? = nil,
        state: SessionState,
        mode: SessionMode,
        lastSeq: Int,
        readSeq: Int,
        messageCount: Int,
        createdAt: Date,
        usage: SessionUsage? = nil,
        pinned: Bool,
        currentToolName: String? = nil,
        currentToolHeadline: String? = nil,
        activity: SessionActivity = .none
    ) {
        self.id = id
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.agent = agent
        self.model = model
        self.title = title
        self.autoTitle = autoTitle
        self.state = state
        self.mode = mode
        self.lastSeq = lastSeq
        self.readSeq = readSeq
        self.messageCount = messageCount
        self.createdAt = createdAt
        self.usage = usage
        self.pinned = pinned
        self.currentToolName = currentToolName
        self.currentToolHeadline = currentToolHeadline
        self.activity = activity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.deviceId = try c.decode(String.self, forKey: .deviceId)
        self.deviceName = try c.decode(String.self, forKey: .deviceName)
        self.agent = try c.decode(String.self, forKey: .agent)
        self.model = try c.decodeIfPresent(String.self, forKey: .model)
        self.title = try c.decodeIfPresent(String.self, forKey: .title)
        self.autoTitle = try c.decodeIfPresent(String.self, forKey: .autoTitle)
        self.state = try c.decode(SessionState.self, forKey: .state)
        self.mode = try c.decode(SessionMode.self, forKey: .mode)
        self.lastSeq = try c.decode(Int.self, forKey: .lastSeq)
        self.readSeq = try c.decode(Int.self, forKey: .readSeq)
        self.messageCount = try c.decode(Int.self, forKey: .messageCount)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.usage = try c.decodeIfPresent(SessionUsage.self, forKey: .usage)
        self.pinned = try c.decode(Bool.self, forKey: .pinned)
        // Transient fields default to neutral values on load.
        self.currentToolName = nil
        self.currentToolHeadline = nil
        self.activity = .none
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(deviceId, forKey: .deviceId)
        try c.encode(deviceName, forKey: .deviceName)
        try c.encode(agent, forKey: .agent)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(autoTitle, forKey: .autoTitle)
        try c.encode(state, forKey: .state)
        try c.encode(mode, forKey: .mode)
        try c.encode(lastSeq, forKey: .lastSeq)
        try c.encode(readSeq, forKey: .readSeq)
        try c.encode(messageCount, forKey: .messageCount)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(usage, forKey: .usage)
        try c.encode(pinned, forKey: .pinned)
    }
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
    /// Bumped when a session is deleted while it's being viewed.
    /// `MainTabView` observes this and pops the session navigation
    /// stack so the user lands on the session list instead of the
    /// "Session not found" placeholder. Counter (not boolean) so two
    /// rapid deletes don't share the same value and get coalesced.
    var popToSessionListSignal: Int = 0
    var streamingContent: [String: String] = [:]

    // MARK: - Disk snapshot

    /// On-disk snapshot of session metadata + previews. Hydrated
    /// synchronously on init so cold-launch users see a populated
    /// session list before the WS reconnects; overwritten by
    /// authoritative `session_list` data once it arrives.
    /// Stored at `<ApplicationSupport>/Kraki/sessions.json` (a single
    /// JSON file — small, infrequent writes, atomic).

    private struct Snapshot: Codable {
        var sessions: [String: SessionInfo]
        var previews: [String: SessionPreview]
    }

    /// Debounce window for save coalescing. Many small mutations in
    /// one burst (bumpLastSeq, setPreview, setMode, …) should result
    /// in one write, not N.
    private static let saveDebounce: TimeInterval = 1.0
    private var saveTask: DispatchWorkItem?
    private var pendingSnapshot: Snapshot?
    /// SHA-equivalent stable hash of the bytes last written to disk.
    /// Used by `flushCache` to skip rewrites of identical content
    /// (common when a non-card-visible field churns: active session
    /// toggles, transient streaming state, etc. — see KLog dump in
    /// PID 52588: 3 flushes of identical 69550 bytes within 9s).
    private var lastFlushedHash: Int?

    private static let snapshotURL: URL = {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("Kraki", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("sessions.json", isDirectory: false)
    }()

    init() {
        let path = Self.snapshotURL.path
        guard FileManager.default.fileExists(atPath: path) else {
            KLog.chat("📂 [snapshot] init: no file at \(path) — starting empty")
            return
        }
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? -1
        guard let data = try? Data(contentsOf: Self.snapshotURL) else {
            KLog.chat("📂 [snapshot] init: read FAILED size=\(fileSize) path=\(path)")
            return
        }
        do {
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
            self.sessions = snapshot.sessions
            self.sessionPreviews = snapshot.previews
            for (id, s) in snapshot.sessions {
                sessionModes[id] = s.mode
                if let u = s.usage { sessionUsage[id] = u }
                if s.pinned { pinnedSessions.insert(id) }
            }
            KLog.chat("📂 [snapshot] init: hydrated sessions=\(snapshot.sessions.count) previews=\(snapshot.previews.count) bytes=\(data.count)")
        } catch {
            KLog.chat("📂 [snapshot] init: DECODE FAILED bytes=\(data.count) error=\(error)")
        }
    }

    /// Schedules a debounced write of the current observable state to
    /// disk. Called after any mutation that changes a card-visible field.
    /// Safe to call frequently — the cache coalesces.
    fileprivate func scheduleSave() {
        pendingSnapshot = Snapshot(sessions: sessions, previews: sessionPreviews)
        saveTask?.cancel()
        let task = DispatchWorkItem { [weak self] in self?.flushCache() }
        saveTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDebounce, execute: task)
    }

    /// Force-flush the pending snapshot to disk immediately. Called
    /// from app background / logout so the latest state survives
    /// termination even if the user kills the app before the debounce
    /// fires.
    func flushCache() {
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = pendingSnapshot else { return }
        pendingSnapshot = nil
        guard let data = try? JSONEncoder().encode(snapshot) else {
            KLog.chat("📂 [snapshot] flush: encode FAILED sessions=\(snapshot.sessions.count)")
            return
        }
        let hash = data.hashValue
        if hash == lastFlushedHash {
            KLog.chat("📂 [snapshot] flush: skip identical sessions=\(snapshot.sessions.count) bytes=\(data.count)")
            return
        }
        do {
            try data.write(to: Self.snapshotURL, options: .atomic)
            lastFlushedHash = hash
            KLog.chat("📂 [snapshot] flush: wrote sessions=\(snapshot.sessions.count) bytes=\(data.count)")
        } catch {
            KLog.chat("📂 [snapshot] flush: write FAILED error=\(error)")
        }
    }

    /// Wipe the persisted snapshot file (called by logout / reset).
    /// In-memory state is untouched; callers usually clear it
    /// separately.
    func clearPersistentSnapshot() {
        saveTask?.cancel()
        saveTask = nil
        pendingSnapshot = nil
        lastFlushedHash = nil
        try? FileManager.default.removeItem(at: Self.snapshotURL)
        KLog.chat("📂 [snapshot] clearPersistentSnapshot: file removed")
    }

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

    /// Sessions whose most recent `request_session_messages` timed out
    /// without a `replay_batch` arriving. Views can show a "couldn't
    /// load — tap to retry" affordance for entries in this set.
    /// Cleared automatically on the next successful batch or retry.
    var loadFailedSessions: Set<String> = []

    func setLoading(_ id: String, _ loading: Bool) {
        if loading {
            loadingSessions.insert(id)
            // Clear any previous failure marker — we're retrying now.
            loadFailedSessions.remove(id)
        } else {
            loadingSessions.remove(id)
        }
    }

    func markLoadFailed(_ id: String) {
        loadFailedSessions.insert(id)
        loadingSessions.remove(id)
    }

    func isLoading(_ id: String) -> Bool {
        loadingSessions.contains(id)
    }

    func didLoadFail(_ id: String) -> Bool {
        loadFailedSessions.contains(id)
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

    // MARK: - Test-Compat Shims
    //
    // Earlier versions of the store kept an explicit counter-based
    // unread map (`unreadCounts`) and helpers like `incrementUnread`
    // / `clearUnread`. The seq-based model replaced those, but the
    // existing `SessionStoreTests` suite still drives the legacy
    // surface. We keep these shims so the test suite stays
    // authoritative without rewriting every test, while production
    // code continues to use the seq-based API directly.

    /// Counter view derived from `lastSeq − readSeq`.
    var unreadCounts: [String: Int] {
        var out: [String: Int] = [:]
        for (id, s) in sessions {
            let c = max(0, s.lastSeq - s.readSeq)
            if c > 0 { out[id] = c }
        }
        return out
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

    // MARK: - Computed

    /// Sessions sorted: pinned first, then by effective timestamp
    /// descending (latest preview if any, else session.createdAt),
    /// then by createdAt as a final tiebreaker. The fallback to
    /// createdAt for sessions without a live preview keeps freshly-
    /// created or freshly-imported sessions at the top after a cold
    /// relaunch, when their in-memory preview entry hasn't been
    /// seeded yet.
    var sortedSessions: [SessionInfo] {
        // Resolve each session's effective timestamp to a Date so we
        // can compare across mixed "Z" vs "+00:00" timestamp shapes
        // without string-compare bugs. Falls back to createdAt when
        // the preview hasn't been seeded yet.
        func effectiveDate(_ s: SessionInfo) -> Date {
            if let t = sessionPreviews[s.id]?.timestamp,
               !t.isEmpty,
               let d = ISO8601.parse(t) {
                return d
            }
            return s.createdAt
        }
        return sessions.values.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            let aDate = effectiveDate(a)
            let bDate = effectiveDate(b)
            if aDate != bDate { return aDate > bDate }
            return a.createdAt > b.createdAt
        }
    }

    var totalUnread: Int {
        sessions.values.reduce(0) { $0 + max(0, $1.lastSeq - $1.readSeq) }
    }

    // MARK: - Session CRUD

    func upsertSession(_ digest: SessionDigest, deviceId: String, deviceName: String) {
        let date = ISO8601.parse(digest.createdAt) ?? Date()

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
        scheduleSave()
    }

    func removeSession(_ id: String) {
        sessions.removeValue(forKey: id)
        pinnedSessions.remove(id)
        sessionModes.removeValue(forKey: id)
        sessionUsage.removeValue(forKey: id)
        sessionPreviews.removeValue(forKey: id)
        drafts.removeValue(forKey: id)
        streamingContent.removeValue(forKey: id)
        scheduleSave()
    }

    // MARK: - Session Properties

    func setMode(_ id: String, _ mode: SessionMode) {
        sessionModes[id] = mode
        sessions[id]?.mode = mode
        scheduleSave()
    }

    func setModel(_ id: String, _ model: String) {
        sessions[id]?.model = model
        scheduleSave()
    }

    func setTitle(_ id: String, title: String?, autoTitle: String?) {
        if let title { sessions[id]?.title = title.isEmpty ? nil : title }
        if let autoTitle { sessions[id]?.autoTitle = autoTitle.isEmpty ? nil : autoTitle }
        scheduleSave()
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
        scheduleSave()
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
        scheduleSave()
    }

    // MARK: - Pin

    func setPinned(_ id: String, _ pinned: Bool) {
        sessions[id]?.pinned = pinned
        if pinned {
            pinnedSessions.insert(id)
        } else {
            pinnedSessions.remove(id)
        }
        scheduleSave()
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
            scheduleSave()
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
            scheduleSave()
        }
    }

    // MARK: - Preview / Draft

    func setPreview(_ id: String, text: String, type: String = "message", timestamp: String = "") {
        sessionPreviews[id] = SessionPreview(text: text, type: type, timestamp: timestamp)
        scheduleSave()
    }

    func setDraft(_ id: String, _ text: String) {
        if text.isEmpty {
            drafts.removeValue(forKey: id)
        } else {
            drafts[id] = text
        }
    }

    // MARK: - Streaming Deltas

    /// Per-session pending text buffered between flushes. Holds bytes
    /// that have arrived from the relay but haven't yet been promoted
    /// into the observed `streamingContent` dict (which is what views
    /// read).
    private var pendingDeltaBuffer: [String: String] = [:]
    /// Per-session debounce task. Each `appendDelta` cancels the
    /// previous task and schedules a fresh one.
    private var pendingDeltaTasks: [String: Task<Void, Never>] = [:]
    /// Window between buffer-write and observed-state-update. Tuned
    /// so each session re-renders its chat at most ~4 times/sec
    /// during streaming. Captures the full speed of the underlying
    /// `agent_message_delta` firehose without making the UI re-parse
    /// and re-layout per token.
    private static let deltaCoalesceWindow: Duration = .milliseconds(250)

    /// Append streaming text from an `agent_message_delta` event.
    ///
    /// Coalesces bursts: bytes go into `pendingDeltaBuffer` immediately
    /// but `streamingContent` (the observed state every chat view
    /// reads) only ticks after a 250 ms quiet window. With the
    /// previous unbatched implementation, a fast burst of 30–50
    /// deltas/sec produced 30–50 full chat re-renders per second on
    /// the same growing string. Now the views see roughly four
    /// updates per second instead, regardless of how fast the agent
    /// emits tokens. Final-turn `flushDelta` empties the buffer
    /// cleanly so no bytes are lost across the idle boundary.
    func appendDelta(_ id: String, _ content: String) {
        pendingDeltaBuffer[id, default: ""] += content
        pendingDeltaTasks[id]?.cancel()
        pendingDeltaTasks[id] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.deltaCoalesceWindow)
            guard !Task.isCancelled, let self else { return }
            self.promotePendingDelta(id)
        }
    }

    /// Promote any buffered bytes for `id` into the observable
    /// `streamingContent` so views re-render once with the new
    /// suffix appended. Called by the debounce task and again
    /// synchronously from `flushDelta` so a finalised turn always
    /// shows its complete pre-idle text right up until the bubble
    /// swaps to the canonical agent_message rendering.
    ///
    /// Also drives the session-card activity row: each promotion
    /// updates the `.agentText(running)` snapshot with the FULL
    /// accumulated content, not just the latest chunk. Doing it here
    /// (instead of per-event in MessageRouter) means the card
    /// preview is debounced for free — it ticks at ~4 Hz instead of
    /// per-delta — AND it shows the entire running reply so far
    /// instead of just the last chunk.
    private func promotePendingDelta(_ id: String) {
        guard let buffered = pendingDeltaBuffer.removeValue(forKey: id),
              !buffered.isEmpty else { return }
        let running = (streamingContent[id] ?? "") + buffered
        streamingContent[id] = running
        // Refresh the activity preview with the accumulated text.
        // Trimmed/single-line conversion is done by the card view
        // (`collapseWhitespace`) on read, so we keep the raw blob
        // here. Guard the activity write with the same "session
        // must be active" check `setAgentTextActivity` enforces.
        if sessions[id]?.state == .active {
            sessions[id]?.activity = .agentText(running)
        }
    }

    /// Flush and return accumulated delta content, or nil if none.
    @discardableResult
    func flushDelta(_ id: String) -> String? {
        // Cancel any in-flight debounce so the pending bytes don't
        // land AFTER the flush and resurrect a stale streaming
        // bubble. Then drain the buffer synchronously so callers
        // see a fully-up-to-date final blob before removal.
        pendingDeltaTasks.removeValue(forKey: id)?.cancel()
        promotePendingDelta(id)
        return streamingContent.removeValue(forKey: id)
    }

    /// Test-only synchronous promotion of pending deltas. Production
    /// code drives this via the debounce task (~250ms) or `flushDelta`
    /// at turn end. Exposed so tests can deterministically observe
    /// the buffer landing in `streamingContent` without sleeping.
    func promotePendingDeltaForTesting(_ id: String) {
        promotePendingDelta(id)
    }

    // MARK: - Reset

    func clearTransientState() {
        cancelAllDeltaTasks()
        streamingContent.removeAll()
        sessionUsage.removeAll()
    }

    func reset() {
        KLog.chat("📂 [snapshot] reset: sessions=\(sessions.count) → 0 (clearing persistent snapshot)")
        cancelAllDeltaTasks()
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
        loadFailedSessions.removeAll()
        entryUnreadSnapshots.removeAll()
        clearPersistentSnapshot()
    }

    /// Cancel every in-flight delta debounce + drop buffered bytes.
    /// Called from reset paths so we don't leak Tasks that wake up
    /// after the session has been torn down.
    private func cancelAllDeltaTasks() {
        for (_, task) in pendingDeltaTasks { task.cancel() }
        pendingDeltaTasks.removeAll()
        pendingDeltaBuffer.removeAll()
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
        scheduleSave()
    }

    /// Sync sessions from a parsed session list.
    func syncSessions(_ summaries: [SessionDigest], deviceId: String = "", deviceName: String = "") {
        for digest in summaries {
            upsertSession(digest, deviceId: deviceId, deviceName: deviceName)
        }
    }
}
