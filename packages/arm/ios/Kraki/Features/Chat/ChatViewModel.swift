#if os(iOS)
/// ChatViewModel — Pure-data view model for a single chat session.
///
/// Lifted out of `ChatView` body so the expensive derived values
/// (`groupMessagesIntoTurns`, `filteredMessages`, etc.) are computed
/// once per data change rather than once per SwiftUI body invocation.
///
/// Owns:
///   • Filtered message list for the session
///   • Grouped turn cache (`cachedRawTurns`, `cachedAllTurnCount`,
///     `lastKnownFirstTurnId`) and the `refreshGroupingCache`
///     entry-point that swaps it.
///   • Streaming text snapshot, session-idle flag, last user message
///     pointer — all derived from the message list.
///   • The pending-permission and pending-question slices for this
///     session.
///   • The device-online flag.
///   • The `showCenterLoading` gate.
///
/// Does NOT own:
///   • Render-window state (`renderWindowStartIdx`, `renderedTurnCount`)
///     — still in `ChatView` for Stage 0. Goes away in Stage 4 when
///     `UICollectionView` takes over virtualization.
///   • Scroll metrics, growMode, anchor lock — all still in `ChatView`
///     for Stage 0; move to `ChatScrollCoordinator` in Stage 2.
///   • SwiftUI rendering — the view reads from this object.
///
/// Lifecycle: created by `ChatView.task(id: sessionId)` on entry,
/// kept alive while the session is open. Subscribes to the relevant
/// store slices via `onChange` modifiers on `ChatView`; the model
/// itself doesn't observe anything — the view tells it when data
/// changed.

import Foundation
import Observation

@Observable
@MainActor
final class ChatViewModel {
    /// Session identity — never changes for a given instance. A new
    /// session means a new instance.
    let sessionId: String

    /// Weak ref to the global app state for store access. Held weak
    /// because AppState is the lifetime owner; the view model lives
    /// inside a SwiftUI view that AppState's tree contains.
    private weak var appState: AppState?

    // MARK: - Cached groupings

    /// Raw turns from `groupMessagesIntoTurns(filteredMessages)`.
    /// Recomputed only on `refreshGroupingCache()` calls — never on
    /// observation reads. The grouping is O(n) over all in-memory
    /// messages (2000+ in long sessions) and accessing it as a plain
    /// computed property caused the main thread to stall long enough
    /// for WebSocket heartbeats to time out — symptom: opening the
    /// session disconnected the relay.
    private(set) var cachedRawTurns: [TurnItem] = []

    /// Mirror of `cachedRawTurns.count + (streaming-extra-turn ? 1 : 0)`
    /// for cheap O(1) reads. Kept in sync with `cachedRawTurns` in
    /// `refreshGroupingCache`.
    private(set) var cachedAllTurnCount: Int = 0

    /// First-turn id at the time of the last `refreshGroupingCache`
    /// call. Used by the prepend-follow logic so the render-window
    /// indices can be shifted to keep pointing at the same physical
    /// turns when older history arrives via backfill.
    private(set) var lastKnownFirstTurnId: String?

    // MARK: - Derived from message list

    /// All messages for this session. Pending permissions stay inline
    /// so the user sees the request in chat history, mirroring how
    /// pending questions behave.
    var filteredMessages: [ChatMessage] {
        appState?.messageStore.messages[sessionId] ?? []
    }

    /// Streaming content for this session. Non-nil during agent reply
    /// streaming; cleared on `idle`.
    var streaming: String? {
        appState?.sessionStore.streamingContent[sessionId]
    }

    /// True if the last persisted message is `idle` — i.e. the agent
    /// has finished its current turn. Drives the R1 release and the
    /// idle-anchor acquisition.
    var sessionIdle: Bool {
        guard let last = filteredMessages.last else { return true }
        return last.type == "idle"
    }

    /// Last user-side message (user_message or send_input), used as
    /// the scroll target for R3-unread and R1/R2 anchoring.
    var lastUserMessage: ChatMessage? {
        filteredMessages.last(where: { $0.type == "user_message" || $0.type == "send_input" })
    }

    // MARK: - Pending action slices

    /// Pending permissions for this session, in arrival order.
    var permissions: [PendingPermission] {
        appState?.messageStore.permissionsForSession(sessionId) ?? []
    }

    /// Pending questions for this session, in arrival order.
    var questions: [PendingQuestion] {
        appState?.messageStore.questionsForSession(sessionId) ?? []
    }

    // MARK: - Session + device

    /// Current `SessionInfo` for this session, or nil if not yet
    /// hydrated.
    var session: SessionInfo? {
        appState?.sessionStore.sessions[sessionId]
    }

    /// True if the tentacle device backing this session is online.
    /// Drives the input-area visibility (we never hide the input on
    /// relay blips — only when the device itself is offline).
    var isDeviceOnline: Bool {
        guard let deviceId = session?.deviceId,
              let device = appState?.deviceStore.devices[deviceId] else { return false }
        return device.online
    }

    /// True if we know we have the latest turn cached. False during
    /// the very first paint of an unread session, before any messages
    /// have arrived. Drives `showCenterLoading`.
    var latestTurnLoaded: Bool {
        !filteredMessages.isEmpty
    }

    /// True when we should show the centered loading spinner instead
    /// of the message list + compose footer (Phase A — no messages
    /// yet AND a fetch is in flight).
    var showCenterLoading: Bool {
        guard let appState else { return false }
        return !latestTurnLoaded && appState.sessionStore.loadingSessions.contains(sessionId)
    }

    // MARK: - Init

    init(sessionId: String, appState: AppState) {
        self.sessionId = sessionId
        self.appState = appState
    }

    // MARK: - Mutators

    /// Recompute the cached turn grouping. Called by `ChatView` from
    /// `onChange(of: filteredMessages.count)` and `onChange(of:
    /// streaming)` transitions. Idempotent; safe to call repeatedly.
    ///
    /// Returns the diff result so the caller can apply window-index
    /// adjustments (prepend-follow shift) without re-reading the
    /// previous-first-id state. The Stage 0 caller in `ChatView` uses
    /// this to keep `renderWindowStartIdx` pointed at the same
    /// physical turns across backfill arrivals.
    @discardableResult
    func refreshGroupingCache() -> GroupingRefreshResult {
        let newRaw = groupMessagesIntoTurns(filteredMessages)
        let previousFirstTurnId = lastKnownFirstTurnId
        cachedRawTurns = newRaw
        // Count includes the synthetic streaming turn only when
        // streaming is actively producing content AND the last cached
        // block isn't already an in-progress block (which already
        // contains the streaming text).
        let streamingTailNeeded: Bool = {
            guard streaming != nil else { return false }
            if let last = newRaw.last, case .block(let block) = last, block.finalMessage == nil {
                return false
            }
            return true
        }()
        cachedAllTurnCount = newRaw.count + (streamingTailNeeded ? 1 : 0)
        lastKnownFirstTurnId = newRaw.first?.id
        return GroupingRefreshResult(
            newRaw: newRaw,
            previousFirstTurnId: previousFirstTurnId
        )
    }

    /// Returned from `refreshGroupingCache()` so the caller can decide
    /// what to do with the change (e.g. shift render-window indices to
    /// preserve "current physical turn" semantics across prepends).
    struct GroupingRefreshResult {
        let newRaw: [TurnItem]
        let previousFirstTurnId: String?
    }
}
#endif
