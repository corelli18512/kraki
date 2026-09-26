// ChatViewModel — pure-data view model for a single chat session.
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
                || message.payload[ChatMessage.closesQuestionKey]?.boolValue == true
        }
        return true
    }

    private var pendingInputsRaw: [ChatMessage] {
        appState?.commandSender?.pendingInputs(sessionId) ?? []
    }

    /// Synthesised optimistic pending-input messages from the outbox.
    var pendingMessages: [ChatMessage] {
        let pending = appState?.commandSender?.pendingInputs(sessionId) ?? []
        guard !pending.isEmpty else { return [] }
        // A retried or restored input whose echo already landed (Tentacle
        // deduplicates by clientId and may not re-echo) must not render twice.
        let landed = Set(cachedMessages.compactMap { $0.payload["clientId"]?.stringValue })
        guard !landed.isEmpty else { return pending }
        return pending.filter { message in
            guard let clientId = message.payload["clientId"]?.stringValue else { return true }
            return !landed.contains(clientId)
        }
    }

    /// Identity + delivery state of every optimistic input. Read by the view
    /// so outbox changes (new send, failed, retried) always re-render.
    var pendingSignature: String {
        (appState?.commandSender?.pendingInputs(sessionId) ?? [])
            // Text is part of the signature: a correcting voice bubble's
            // content streams in place.
            .map { "\($0.id)#\($0.payload["localState"]?.stringValue ?? "")#\($0.content?.hashValue ?? 0)" }
            .joined(separator: ",")
    }

    /// Confirmed spine bubbles plus optimistic pending input.
    var displayMessages: [ChatMessage] { cachedMessages + pendingMessages }

    @ObservationIgnored private var currentSpineMemo: (revision: Int, messages: [ChatMessage])?

    /// Spine + pending for the *current* store revision, computed during the
    /// render that observes the change. `cachedMessages` is refreshed from
    /// `onChange`, which runs after that render: a turn landing (live card
    /// cleared + answer persisted in one runloop turn) otherwise renders one
    /// frame with neither the live bubble nor the answer.
    func displayMessages(spineRevision revision: Int) -> [ChatMessage] {
        if let memo = currentSpineMemo, memo.revision == revision {
            return memo.messages + pendingMessages(landedIn: memo.messages)
        }
        let spine = TurnSpineProjection.project(
            Self.annotatingQuestions(filteredMessages, pending: pendingInputsRaw, atHead: windowAtHead)
        ).filter(Self.shouldRender)
        currentSpineMemo = (revision, spine)
        return spine + pendingMessages(landedIn: spine)
    }

    private func pendingMessages(landedIn spine: [ChatMessage]) -> [ChatMessage] {
        let pending = appState?.commandSender?.pendingInputs(sessionId) ?? []
        guard !pending.isEmpty else { return [] }
        let landed = Set(spine.compactMap { $0.payload["clientId"]?.stringValue })
        return pending.filter { message in
            guard let clientId = message.payload["clientId"]?.stringValue else { return true }
            return !landed.contains(clientId)
        }
    }

    /// Recompute the flat spine snapshot. Called by the view on data changes.
    func refreshMessageCache() {
        cachedMessages = TurnSpineProjection.project(
            Self.annotatingQuestions(filteredMessages, pending: pendingInputsRaw, atHead: windowAtHead)
        ).filter(Self.shouldRender)
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

    /// Open questions (oldest first), derived from the spine. The composer
    /// answers the newest one.
    var questions: [PendingQuestion] {
        // Derived from the live window (not the render cache) so any view
        // model instance — e.g. the composer's — sees the current state.
        let raw = filteredMessages
        guard raw.contains(where: { $0.questionSpec != nil }) else { return [] }
        let annotated = Self.annotatingQuestions(raw, pending: pendingInputsRaw, atHead: windowAtHead)
        return annotated.compactMap { message in
            guard message.questionState == "open", let spec = message.questionSpec else { return nil }
            return PendingQuestion(id: spec.id, sessionId: sessionId, question: spec.text,
                                   choices: spec.choices.isEmpty ? nil : spec.choices, timestamp: Date())
        }
    }

    /// Stamp each question's display state from what follows it on the spine:
    /// - an answer (`answerTo` = its id, persisted or optimistic) → answered;
    /// - other questions, answers to them, and transient `error` rows are
    ///   neutral;
    /// - anything else (a reply, a plain message, idle, terminal status) →
    ///   unanswered (the agent no longer waits for it);
    /// - nothing yet: open at the conversation head, otherwise unknown
    ///   ("closed", rendered neutrally).
    static func annotatingQuestions(_ raw: [ChatMessage], pending: [ChatMessage],
                                    atHead: Bool) -> [ChatMessage] {
        guard raw.contains(where: { $0.questionSpec != nil }) else { return raw }
        var result = raw
        for index in raw.indices {
            guard let spec = raw[index].questionSpec else { continue }
            var state: String?
            for laterIndex in raw.indices where laterIndex > index {
                let later = raw[laterIndex]
                if later.answerTo == spec.id { state = "answered"; break }
                if later.questionSpec != nil || later.answerTo != nil || later.type == "error" { continue }
                state = "unanswered"
                if later.type == "turn_status" || later.type == "interrupted_turn" {
                    // Aborted/failed while asking: show that terminal card
                    // ("User aborted") even though it carries no draft.
                    result[laterIndex].payload[ChatMessage.closesQuestionKey] = AnyCodable(true)
                }
                break
            }
            if state == nil {
                if pending.contains(where: { $0.answerTo == spec.id }) { state = "answered" }
                else { state = atHead ? "open" : "closed" }
            }
            result[index].payload[ChatMessage.questionStateKey] = AnyCodable(state!)
        }
        return result
    }

    private var windowAtHead: Bool { appState?.messageProvider?.atHead(sessionId) ?? true }

    // MARK: - Session + device

    var session: SessionInfo? { appState?.sessionStore.sessions[sessionId] }

    var isDeviceOnline: Bool {
        guard let deviceId = session?.deviceId,
              let device = appState?.deviceStore.devices[deviceId] else { return false }
        return device.online
    }

    /// Keep stale cached history off-screen only while a real head request is
    /// still in flight. `SessionInfo.lastSeq` and the raw window boundaries are
    /// both persistent-spine seqs; `cachedMessages` is merely the renderable
    /// projection, so nonvisual idle/error/lifecycle rows do not affect whether
    /// the raw cache has reached the authoritative Tentacle head.
    var isWaitingForLatestBubble: Bool {
        guard isDeviceOnline else { return false }
        let sessionLoading = appState?.sessionStore.loadingSessions.contains(sessionId) ?? false
        guard sessionLoading else { return false }
        let expectedLastSeq = max(session?.lastSeq ?? 0, sessionLastSeq)
        return ChatEntryLoading.isWaitingForLatest(
            expectedLastSeq: expectedLastSeq,
            windowBottomSeq: windowBottomSeq,
            hasMessages: !filteredMessages.isEmpty,
            sessionLoading: sessionLoading
        )
    }

    // MARK: - Edge state (top/bottom spinners)

    var isLoadingOlder: Bool {
        guard let provider = appState?.messageProvider else { return false }
        return provider.isLoadingOlder(sessionId) || provider.isLoadingOlderDB(sessionId)
    }
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
