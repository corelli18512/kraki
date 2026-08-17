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
        case state, mode, lastSeq, readSeq
        case messageCount, createdAt, usage, pinned
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
    /// Ephemeral UI guard for a manual Mark Unread on the currently open Chat.
    /// Tentacle remains durable authority; this only prevents focus/live-event
    /// auto-read hooks from immediately undoing an intentional rollback.
    private(set) var autoReadSuppressedSessions: Set<String> = []
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

    var navigationOrderedSessions: [SessionInfo] {
        let previews = sessionPreviews
        return sessions.values.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            let aTs = previews[a.id]?.timestamp ?? ""
            let bTs = previews[b.id]?.timestamp ?? ""
            if aTs != bTs { return bTs < aTs }
            return a.createdAt > b.createdAt
        }
    }

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
    /// one burst (observeLastSeq, setPreview, setMode, …) should result
    /// in one write, not N. The snapshot is a cold-launch optimisation
    /// — `session_list` re-authoritatively overwrites it within seconds
    /// of WS connect — so we can afford a long debounce and lean on the
    /// `handleBackground` / `applicationWillTerminate` flush hooks to
    /// guarantee the latest state hits disk before the process dies.
    private static let saveDebounce: TimeInterval = 10.0
    private let persistenceEnabled: Bool
    private var saveTask: DispatchWorkItem?
    private var pendingSnapshot: Snapshot?
    /// SHA-equivalent stable hash of the bytes last written to disk.
    /// Used by `flushCache` to skip rewrites of identical content
    /// (common when a non-card-visible field churns: active session
    /// toggles, transient streaming state, etc. — see KLog dump in
    /// PID 52588: 3 flushes of identical 69550 bytes within 9s).
    private var lastFlushedHash: Int?

    private static let snapshotURL: URL = {
        KrakiDataPaths.persistentDirectory()
            .appendingPathComponent("sessions.json", isDirectory: false)
    }()

    init(persistenceEnabled: Bool = true) {
        self.persistenceEnabled = persistenceEnabled
        guard persistenceEnabled else { return }
        let path = Self.snapshotURL.path
        guard FileManager.default.fileExists(atPath: path) else {
            KLog.d("📂 [snapshot] init: no file at \(path) — starting empty")
            return
        }
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? -1
        guard let data = try? Data(contentsOf: Self.snapshotURL) else {
            KLog.d("📂 [snapshot] init: read FAILED size=\(fileSize) path=\(path)")
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
            KLog.d("📂 [snapshot] init: hydrated sessions=\(snapshot.sessions.count) previews=\(snapshot.previews.count) bytes=\(data.count)")
        } catch {
            KLog.d("📂 [snapshot] init: DECODE FAILED bytes=\(data.count) error=\(error)")
        }
    }

    /// Schedules a debounced write of the current observable state to
    /// disk. Called after any mutation that changes a card-visible field.
    /// Safe to call frequently — the cache coalesces.
    fileprivate func scheduleSave() {
        guard persistenceEnabled else { return }
        // Compacting is runtime-only. Persist the underlying working fallback
        // so a cold launch cannot resurrect stale compaction before the next
        // authoritative session_list arrives.
        let persistedSessions = sessions.mapValues { session in
            guard session.state == .compacting else { return session }
            var normalized = session
            normalized.state = .active
            return normalized
        }
        pendingSnapshot = Snapshot(sessions: persistedSessions, previews: sessionPreviews)
        let wasScheduled = saveTask != nil
        saveTask?.cancel()
        let task = DispatchWorkItem { [weak self] in self?.flushCache() }
        saveTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDebounce, execute: task)
        if !wasScheduled {
            // Only log when a *new* debounce window opens — not every
            // coalesced call. With debounce=10s we'd otherwise emit a
            // log on every mutation in a burst.
            KLog.d("📂 [snapshot] scheduleSave: debounce=\(Self.saveDebounce)s pending=\(pendingSnapshot?.sessions.count ?? 0)")
        }
    }

    /// Force-flush the pending snapshot to disk immediately. Called
    /// from app background / logout so the latest state survives
    /// termination even if the user kills the app before the debounce
    /// fires.
    func flushCache() {
        guard persistenceEnabled else { return }
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = pendingSnapshot else { return }
        pendingSnapshot = nil
        guard let data = try? JSONEncoder().encode(snapshot) else {
            KLog.d("📂 [snapshot] flush: encode FAILED sessions=\(snapshot.sessions.count)")
            return
        }
        let hash = data.hashValue
        if hash == lastFlushedHash {
            KLog.d("📂 [snapshot] flush: skip identical sessions=\(snapshot.sessions.count) bytes=\(data.count)")
            return
        }
        do {
            try data.write(to: Self.snapshotURL, options: .atomic)
            lastFlushedHash = hash
            KLog.d("📂 [snapshot] flush: wrote sessions=\(snapshot.sessions.count) bytes=\(data.count)")
        } catch {
            KLog.d("📂 [snapshot] flush: write FAILED error=\(error)")
        }
    }

    /// Wipe the persisted snapshot file (called by logout / reset).
    /// In-memory state is untouched; callers usually clear it
    /// separately.
    func clearPersistentSnapshot() {
        guard persistenceEnabled else { return }
        saveTask?.cancel()
        saveTask = nil
        pendingSnapshot = nil
        lastFlushedHash = nil
        try? FileManager.default.removeItem(at: Self.snapshotURL)
        KLog.d("📂 [snapshot] clearPersistentSnapshot: file removed")
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
        //
        // PERF: `ISO8601.parse` is ~20µs per call. A naive comparator
        // that parses inside the closure runs it O(n·log n) times
        // (~17k parses for 865 sessions ≈ 340ms) — a per-websocket-push
        // main-thread hang. Precompute each session's effective date
        // ONCE (a Schwartzian transform), so the comparator does zero
        // parsing: ~865 parses total, ~20x fewer.
        var effective: [String: Date] = Dictionary(minimumCapacity: sessions.count)
        for s in sessions.values {
            if let t = sessionPreviews[s.id]?.timestamp,
               !t.isEmpty,
               let d = ISO8601.parse(t) {
                effective[s.id] = d
            } else {
                effective[s.id] = s.createdAt
            }
        }
        return sessions.values.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            let aDate = effective[a.id] ?? a.createdAt
            let bDate = effective[b.id] ?? b.createdAt
            if aDate != bDate { return aDate > bDate }
            return a.createdAt > b.createdAt
        }
    }

    /// Authoritative unread Session identities. The app icon, tab badge, and
    /// notification extension all project this same boolean-per-Session set.
    var unreadSessionIDs: Set<String> {
        Set(sessions.values.compactMap { session in
            session.readSeq < session.lastSeq ? session.id : nil
        })
    }

    var totalUnread: Int {
        unreadSessionIDs.count
    }

    // MARK: - Session CRUD

    func upsertSession(_ digest: SessionDigest, deviceId: String, deviceName: String) {
        let date = ISO8601.parse(digest.createdAt) ?? Date()

        let mode = digest.mode
        let pinned = digest.pinned ?? pinnedSessions.contains(digest.id)

        if var existing = sessions[digest.id] {
            let previousReadSeq = existing.readSeq
            existing.deviceId = deviceId
            existing.deviceName = deviceName
            existing.agent = digest.agent
            existing.model = digest.model
            existing.title = digest.title
            existing.autoTitle = digest.autoTitle
            existing.state = digest.state
            existing.mode = mode
            // session_list is Tentacle's reconnect authority. Replace both
            // cursors, including a legitimate manual-unread rollback.
            existing.lastSeq = max(0, digest.lastSeq)
            existing.readSeq = min(max(0, digest.readSeq), existing.lastSeq)
            existing.messageCount = digest.messageCount
            existing.usage = digest.usage
            existing.pinned = pinned
            sessions[digest.id] = existing
            if existing.readSeq < previousReadSeq && existing.readSeq < existing.lastSeq {
                suppressAutoRead(digest.id)
            } else if existing.readSeq >= existing.lastSeq {
                allowAutoRead(digest.id)
            }
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
                lastSeq: max(0, digest.lastSeq),
                readSeq: min(max(0, digest.readSeq), max(0, digest.lastSeq)),
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
        // `session_list` is the durable sidebar-preview authority. Its preview
        // is computed by the tentacle from the latest stable turn boundary and
        // may be overlaid by an open question/permission. Replace the local
        // value atomically, including clearing stale optimistic/cache-derived
        // text when the digest intentionally carries no preview.
        if let preview = digest.preview {
            sessionPreviews[digest.id] = preview
        } else {
            sessionPreviews.removeValue(forKey: digest.id)
        }
        if pinned {
            pinnedSessions.insert(digest.id)
        }
        // Unread is projected from Tentacle's authoritative cursor pair.
        scheduleSave()
    }

    func removeSession(_ id: String) {
        sessions.removeValue(forKey: id)
        pinnedSessions.remove(id)
        sessionModes.removeValue(forKey: id)
        sessionUsage.removeValue(forKey: id)
        sessionPreviews.removeValue(forKey: id)
        drafts.removeValue(forKey: id)
        autoReadSuppressedSessions.remove(id)
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
        applyState(id, state)
        scheduleSave()
    }

    /// Apply a live state transition without persisting the metadata snapshot.
    /// `active`/`compacting` carry only global envelope ordering; `idle` is also
    /// a durable spine row, but session_list remains the reconnect authority for
    /// the Session's state and cursor pair.
    func setTransientState(_ id: String, _ state: SessionState) {
        applyState(id, state)
    }

    private func applyState(_ id: String, _ state: SessionState) {
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

    /// Compatibility projection for a raw `tool_start` from an older Tentacle.
    /// Current Tentacles put the live action in `card_action`. The icon
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

    /// Optimistic local projection for an explicit Mark Read command.
    func markRead(_ id: String, seq: Int) {
        guard var session = sessions[id] else { return }
        let clamped = min(max(0, seq), session.lastSeq)
        guard clamped > session.readSeq else { return }
        session.readSeq = clamped
        sessions[id] = session
        scheduleSave()
    }

    /// Apply Tentacle's authoritative session_read cursor in either direction.
    /// A lower value is the synchronized result of Mark Unread.
    func applyAuthoritativeReadSeq(_ id: String, seq: Int) {
        guard var session = sessions[id] else { return }
        let previous = session.readSeq
        // A session_read cursor is also evidence of the producer's head. The
        // next session_list will reconcile any larger head authoritatively.
        session.lastSeq = max(session.lastSeq, max(0, seq))
        session.readSeq = min(max(0, seq), session.lastSeq)
        sessions[id] = session
        if session.readSeq < previous && session.readSeq < session.lastSeq {
            suppressAutoRead(id)
        } else if session.readSeq >= session.lastSeq {
            allowAutoRead(id)
        }
        scheduleSave()
    }

    /// Track the live Spine head. A contiguous ordinary user_message mirrors
    /// Tentacle's implicit cursor rule: when the Session was fully read before
    /// the append, that human message advances both cursors and must not create
    /// an unread badge. A gap never infers Read because a missed attention
    /// boundary may exist inside it; session_list remains final authority.
    func observeLastSeq(
        _ id: String,
        seq: Int,
        advancesReadWhenCaughtUp: Bool = false
    ) {
        guard var session = sessions[id], seq > session.lastSeq else { return }
        let previousLastSeq = session.lastSeq
        let wasCaughtUp = session.readSeq >= previousLastSeq
        let isContiguous = seq == previousLastSeq + 1
        session.lastSeq = seq
        if advancesReadWhenCaughtUp && wasCaughtUp && isContiguous {
            session.readSeq = seq
        }
        sessions[id] = session
        scheduleSave()
    }

    /// Optimistic projection of Tentacle's manual-unread operation.
    func markUnread(_ id: String) {
        guard var session = sessions[id], session.lastSeq > 0 else { return }
        suppressAutoRead(id)
        let rolledBack = min(session.readSeq, max(0, session.lastSeq - 1))
        guard rolledBack != session.readSeq else { return }
        session.readSeq = rolledBack
        sessions[id] = session
        scheduleSave()
    }

    func suppressAutoRead(_ id: String) {
        autoReadSuppressedSessions.insert(id)
    }

    func allowAutoRead(_ id: String) {
        autoReadSuppressedSessions.remove(id)
    }

    func isAutoReadSuppressed(_ id: String) -> Bool {
        autoReadSuppressedSessions.contains(id)
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

    // MARK: - Reset

    func reset() {
        KLog.d("📂 [snapshot] reset: sessions=\(sessions.count) → 0 (clearing persistent snapshot)")
        sessions.removeAll()
        activeSessionId = nil
        autoReadSuppressedSessions.removeAll()
        pinnedSessions.removeAll()
        sessionModes.removeAll()
        sessionUsage.removeAll()
        sessionPreviews.removeAll()
        drafts.removeAll()
        navigateToSession = nil
        loadingSessions.removeAll()
        loadFailedSessions.removeAll()
        entryUnreadSnapshots.removeAll()
        clearPersistentSnapshot()
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
        for digest in summaries {
            upsertSession(digest, deviceId: deviceId, deviceName: deviceName)
        }
    }
}
