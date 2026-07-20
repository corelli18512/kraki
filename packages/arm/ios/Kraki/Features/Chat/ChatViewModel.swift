#if os(iOS)
/// ChatViewModel — pure-data view model for a single chat session.
///
/// Pure-spine model: the loaded window is already message-only (tools /
/// narration / permission / question live off-spine as the card + trace), so
/// there is NO turn grouping. Each renderable spine message becomes one
/// `.standalone` turn; the list renders one bubble per message. Live status
/// (draft + action) comes from the card; per-turn detail from the lazily
/// pulled trace.

import Foundation
import Observation

@Observable
@MainActor
final class ChatViewModel {
    let sessionId: String
    private weak var appState: AppState?

    init(sessionId: String, appState: AppState) {
        self.sessionId = sessionId
        self.appState = appState
    }

    // MARK: - Spine (flat, one bubble per message)

    /// Spine message types that render as their own bubble. Everything else in
    /// the window (idle / active / session lifecycle / metadata) is boundary or
    /// non-visual and is not turned into a cell.
    private static let renderableTypes: Set<String> = [
        "user_message", "send_input", "agent_message", "interrupted_turn", "turn_status", "system_message",
    ]

    /// The window for this session (already message-only).
    var filteredMessages: [ChatMessage] {
        appState?.messageProvider?.currentWindow(sessionId) ?? []
    }

    /// Renderable persisted spine messages, snapshotted for the list engine.
    private(set) var cachedMessages: [ChatMessage] = []

    static func shouldRender(_ message: ChatMessage) -> Bool {
        guard renderableTypes.contains(message.type) else { return false }
        if message.type == "interrupted_turn" || message.type == "turn_status" {
            // Terminal metadata without an agent draft is not conversation
            // content. Its failure/abort status belongs to turn/session state;
            // rendering it would create an empty bubble with only footer/Steps.
            return !(message.interruptedDraft ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return true
    }

    /// Synthesised optimistic pending-input messages from the outbox.
    var pendingMessages: [ChatMessage] {
        appState?.commandSender?.pendingInputs(sessionId) ?? []
    }

    /// Confirmed spine bubbles plus optimistic pending input.
    var displayMessages: [ChatMessage] { cachedMessages + pendingMessages }

    /// Recompute the flat spine snapshot. Called by the view on data changes.
    func refreshMessageCache() {
        cachedMessages = TurnSpineProjection.project(filteredMessages).filter(Self.shouldRender)
    }

    // MARK: - Live card + trace

    /// Live draft text (card narration), nil when empty.
    var streaming: String? {
        let text = appState?.messageStore.cards[sessionId]?.text
        return (text?.isEmpty ?? true) ? nil : text
    }

    /// The live card (draft + action slot) for the in-progress turn, if any.
    var card: MessageStore.SessionCard? {
        appState?.messageStore.cards[sessionId]
    }

    /// Orthogonal session-runtime activity. Never contributes a spine item,
    /// TRACE row, card action, or bubble identity.
    var runtimeStatus: SessionRuntimeStatus {
        appState?.messageStore.runtimeStatus(sessionId) ?? .idle
    }

    var isCompacting: Bool {
        if case .compacting = runtimeStatus { return true }
        return false
    }

    /// Pulled TRACE steps for a concluded bubble (for the "Steps" popup).
    func steps(forBubbleSeq seq: Int) -> [ChatMessage] {
        appState?.messageStore.turnSteps(sessionId, bubbleSeq: seq) ?? []
    }

    /// Request a turn's trace (idempotent; deduped in the provider).
    func requestSteps(forBubbleSeq seq: Int) {
        appState?.messageProvider?.requestTurnTrace(sessionId: sessionId, bubbleSeq: seq)
    }

    // MARK: - Derived from the window

    /// True if the last spine message is `idle` — the turn has ended.
    var sessionIdle: Bool {
        guard let last = filteredMessages.last else { return true }
        return last.type == "idle"
    }

    /// Leading normal prompt for the current logical turn. Steer messages are
    /// visible user bubbles but remain inside this turn and do not become TRACE
    /// anchors.
    var lastUserMessage: ChatMessage? {
        filteredMessages.last {
            ($0.type == "user_message" || $0.type == "send_input")
                && $0.payload["delivery"]?.stringValue != "steer"
        }
    }

    /// Steps hint for the streaming tail card: the running turn's accumulated
    /// step count so far. The live card always offers a Steps affordance while a
    /// turn is in progress (mirrors web `live=true`), so this is a non-zero
    /// placeholder once the turn has produced any trace.
    var lastUserStepsHint: Int {
        // The trace for an in-progress turn grows server-side; show Steps as
        // long as a turn is actually running (card present).
        (streaming != nil || card?.action != nil) ? 1 : 0
    }

    // MARK: - Pending action (from the live card)

    /// The pending permission carried by the card's action slot (or none).
    /// Off-spine now: the standalone `permission` message no longer exists, so
    /// the live prompt's only home is the card.
    var permissions: [PendingPermission] {
        guard let action = card?.action, action.type == "permission",
              action.payload["decision"]?.stringValue == nil,
              let pid = action.permissionId else { return [] }
        return [PendingPermission(
            id: pid, sessionId: sessionId,
            description: action.toolDescription ?? "",
            toolName: action.toolName, args: action.args, timestamp: Date())]
    }

    /// The pending question carried by the card's action slot (or none).
    var questions: [PendingQuestion] {
        guard let action = card?.action, action.type == "question",
              action.answer == nil, !action.cancelled,
              let qid = action.questionId else { return [] }
        return [PendingQuestion(
            id: qid, sessionId: sessionId,
            question: action.question ?? "", choices: action.choices, timestamp: Date())]
    }

    // MARK: - Session + device

    var session: SessionInfo? { appState?.sessionStore.sessions[sessionId] }

    var isDeviceOnline: Bool {
        guard let deviceId = session?.deviceId,
              let device = appState?.deviceStore.devices[deviceId] else { return false }
        return device.online
    }

    /// Keep stale cached history off-screen until the loaded window reaches the
    /// authoritative session head. Otherwise chat opens on an older tail and
    /// visibly jumps when the latest bubble arrives.
    var isWaitingForLatestBubble: Bool {
        let expectedLastSeq = max(session?.lastSeq ?? 0, sessionLastSeq)
        return ChatEntryLoading.isWaitingForLatest(
            expectedLastSeq: expectedLastSeq,
            windowBottomSeq: windowBottomSeq,
            hasMessages: !filteredMessages.isEmpty,
            sessionLoading: appState?.sessionStore.loadingSessions.contains(sessionId) ?? false
        )
    }

    // MARK: - Edge state (top/bottom spinners)

    var isLoadingOlder: Bool { appState?.messageProvider?.isLoadingOlder(sessionId) ?? false }
    var isFillingTail: Bool { appState?.messageProvider?.isFillingTail(sessionId) ?? false }
    var atHistoryStart: Bool { appState?.messageProvider?.atHistoryStart(sessionId) ?? false }
    var atHead: Bool { appState?.messageProvider?.atHead(sessionId) ?? false }
    var windowTopSeq: Int { appState?.messageStore.windowState(sessionId)?.topSeq ?? 0 }
    var windowBottomSeq: Int { appState?.messageStore.windowState(sessionId)?.bottomSeq ?? 0 }
    var sessionLastSeq: Int { appState?.messageProvider?.tentacleLastKnownSeq(sessionId) ?? 0 }

    // MARK: - Load triggers

    @discardableResult
    func loadOlderIfPossible() -> Bool {
        guard let appState, !atHistoryStart, !isLoadingOlder,
              !(appState.messageProvider?.isLoadingOlderDB(sessionId) ?? false) else { return false }
        Task { [weak self] in
            guard let self, let provider = self.appState?.messageProvider else { return }
            await provider.ensureOlderLoadedAsync(sessionId: self.sessionId)
        }
        return true
    }

    func ensureTailLoaded() {
        guard let appState, !atHead else { return }
        _ = appState.messageProvider?.ensureNewerLoaded(sessionId: sessionId)
    }

    /// Page older RAW messages in from the DB (off-main); reports whether the
    /// window moved. Does NOT recompute turns — the caller does that at rest.
    @discardableResult
    func pageOlderRaw() async -> Bool {
        guard let provider = appState?.messageProvider else { return false }
        let before = windowTopSeq
        _ = await provider.ensureOlderLoadedAsync(sessionId: sessionId)
        return windowTopSeq != before
    }

    @discardableResult
    func pageNewerRaw() -> Bool {
        guard let provider = appState?.messageProvider else { return false }
        let before = windowBottomSeq
        _ = provider.ensureNewerLoaded(sessionId: sessionId)
        return windowBottomSeq != before
    }

    /// Reset the window to the DB tail (jump-to-latest).
    func jumpToHead() {
        appState?.messageProvider?.jumpToHead(sessionId: sessionId)
    }
}
#endif
