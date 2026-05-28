#if os(iOS)
/// ChatView — Main chat interface for a session, mirroring ChatView.tsx.
///
/// Groups messages into turns, renders thinking boxes and message bubbles,
/// handles auto-scroll, gap markers, and the blocking input stack at the bottom
/// (permissions → questions → message input).

import SwiftUI

/// PreferenceKey that aggregates the content-space frame of every user
/// message bubble. Keys are ChatMessage.id; values are CGRect in the
/// "chat" coordinate space (the ScrollView's content space).
///
/// Used by the scroll helpers to decide:
///   - R1: when the locked user bubble has reached the viewport top
///   - R2: which user bubble (if any) should be sticky-pinned at the top
private struct UserBubbleFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

/// Compact, Equatable snapshot of the metrics we care about from the
/// ScrollView. Used as the change-trigger value for
/// `.onScrollGeometryChange`.
private struct ChatScrollMetrics: Equatable {
    var offsetY: CGFloat
    var viewportHeight: CGFloat
    var insetTop: CGFloat
    /// Bottom content inset reported by the ScrollView — typically
    /// equals the height of the `.safeAreaInset(edge: .bottom)`
    /// content (input bar + safe area). SwiftUI's `contentSize.height`
    /// includes this region as phantom scrollable space, so the
    /// actual content bottom in scroll-Y coordinates is
    /// `contentHeight - insetBottom`. Without subtracting this,
    /// any "near the bottom of content" check is unreachable.
    var insetBottom: CGFloat
    var contentHeight: CGFloat
}

struct ChatView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState
    @State private var expandedTurns: Set<String> = []

    /// Height of the top "load older" spinner row (matches the
    /// HStack frame below). Combined with `topSpinnerSlop` below to
    /// decide whether the spinner is currently visible enough to
    /// warrant another auto-load round.
    private static let topSpinnerHeight: CGFloat = 36
    /// Extra slack added to spinner-visibility detection so brief
    /// inset jitter (keyboard, safe-area shifts) doesn't bounce the
    /// auto-loader off/on.
    private static let topSpinnerSlop: CGFloat = 24
    /// Number of latest turns to render on session entry. Older turns
    /// stay in memory but are not in the SwiftUI tree (cheaper layout
    /// passes, R1/R2 frame measurement only over the visible window).
    /// The user can scroll up past the rendered window to auto-expand.
    private static let initialRenderTurnCount: Int = 3
    /// Number of additional turns to bring into the rendered window
    /// each time the user hits the spinner threshold and folded
    /// in-memory turns remain.
    private static let renderExpandStep: Int = 3
    /// Hard cap on the rendered window size. Once the window has
    /// grown to this size, further top-edge expansion drops an equal
    /// number of turns from the bottom (sliding window). Conversely
    /// when the user scrolls toward the bottom-edge of the rendered
    /// window with folded turns below, the window slides down. Keeps
    /// layout passes bounded regardless of how much history the user
    /// scrolls through.
    private static let maxRenderedTurns: Int = 8
    /// Distance from the bottom of content (in points) at which the
    /// bottom-edge expansion rule fires. Mirrors `topSpinnerHeight +
    /// topSpinnerSlop` semantics for the other end.
    private static let bottomEdgeSlop: CGFloat = 60
    /// Minimum gap between two consecutive window expansions. Without
    /// throttling, `onScrollGeometryChange` fires fast enough to expand
    /// the entire memory store in one tick once the spinner becomes
    /// visible — defeating the windowing purpose. With debounce the
    /// user sees one batch at a time as they continue scrolling up.
    private static let windowExpandDebounce: TimeInterval = 0.4

    // MARK: - Scroll Tracers
    //
    // Foundation for the three scroll helpers (R1 growing-reply, R2 sticky
    // user bubble, R3 entry positioning). Populated lazily as the view
    // lays out; never touched directly by user input.

    /// User-bubble frames in the "chat" content coordinate space.
    @State private var userBubbleFrames: [String: CGRect] = [:]
    /// Coalesced scroll metrics. Bundling these into a single state
    /// value (rather than 4 separate `@State` vars) means each scroll
    /// event causes ONE observable change for SwiftUI to react to,
    /// rather than four. Eliminates the
    /// `<OnScrollGeometryChange Modifier> tried to update multiple times
    /// per frame` runtime warning.
    @State private var scrollMetrics: ChatScrollMetrics = ChatScrollMetrics(
        offsetY: 0, viewportHeight: 0, insetTop: 0, insetBottom: 0, contentHeight: 0
    )
    /// Content-space y of the viewport top (after content insets).
    private var scrollOffsetY: CGFloat { scrollMetrics.offsetY }
    /// Visible viewport height (after content insets).
    private var viewportHeight: CGFloat { scrollMetrics.viewportHeight }
    /// Top content inset of the chat scroll view, tracked from
    /// `onScrollGeometryChange` so we can convert between our
    /// `scrollOffsetY` (which includes insets) and `ScrollPosition`'s
    /// raw content-offset y when issuing programmatic scrolls.
    private var chatScrollInsetTop: CGFloat { scrollMetrics.insetTop }
    /// Bottom content inset (input bar + safe area). See
    /// `ChatScrollMetrics.insetBottom`.
    private var chatScrollInsetBottom: CGFloat { scrollMetrics.insetBottom }
    /// Total chat scroll content height as reported by SwiftUI
    /// (includes the bottom inset region as phantom space). For
    /// "where does the actual content end" use
    /// `effectiveContentBottom` below.
    private var chatContentHeight: CGFloat { scrollMetrics.contentHeight }
    /// Effective content end in scroll-Y coordinates — the largest
    /// `viewportBottomY` the user can reach at max scroll. Computed
    /// as `contentHeight - insetBottom` to strip out the phantom
    /// scrollable space SwiftUI adds for the safe-area inset.
    private var effectiveContentBottom: CGFloat {
        chatContentHeight - chatScrollInsetBottom
    }

    // MARK: - R3 Entry State

    /// True once the entry-time scroll positioning has been performed for
    /// the current sessionId. Reset when sessionId changes.
    @State private var didInitialScroll = false

    // MARK: - Render windowing (Phase C)
    //
    // We render a SLIDING window of turns from the grouped message
    // list — the bounds are `[renderWindowStartIdx, renderWindowStartIdx
    // + renderedTurnCount)`. Older turns stay in `messageStore` but
    // are not in the SwiftUI tree, so layout passes and R1/R2 frame
    // measurement scale with the visible window rather than the
    // entire session history.
    //
    // The window auto-grows and slides as the user scrolls:
    //   - Top edge near viewport: expand top. If already at
    //     `maxRenderedTurns`, slide window up (drop bottom turns).
    //   - Bottom edge near viewport and folded turns below: slide
    //     window down (drop top turns).
    //   - New user message arrives (R1 triggers): snap window to
    //     latest turns so R1 has the live turn in tree.

    /// Number of turns currently rendered (slice size). Reset to
    /// `initialRenderTurnCount` on session entry; grown by
    /// `renderExpandStep` per expansion up to `maxRenderedTurns`.
    /// Beyond that the window slides via `renderWindowStartIdx`
    /// rather than growing.
    @State private var renderedTurnCount: Int = ChatView.initialRenderTurnCount
    /// Offset within `allGroupedTurns` of the topmost rendered turn.
    /// Render slice = `allGroupedTurns[startIdx ..< startIdx + renderedTurnCount]`.
    /// Initialized at session entry to anchor the window at the
    /// bottom (`max(0, totalTurns - initialRenderTurnCount)`).
    @State private var renderWindowStartIdx: Int = 0
    /// Timestamp of the last window expansion. Used to debounce so a
    /// single at-edge tick doesn't cascade through the entire memory
    /// store in one render pass.
    @State private var lastWindowExpansion: Date? = nil
    /// Anchor capture for top-edge expansion: the bubble id and its
    /// pre-expand `screenY` (i.e., `bubble.minY - scrollOffsetY`).
    /// Set synchronously in `handleTopEdgeExpand` BEFORE the state
    /// mutation; consumed asynchronously by the next
    /// `UserBubbleFramesKey` preference fire (post-layout) which
    /// scrolls to `newBubble.minY - screenY` so the bubble lands at
    /// the exact same screen Y as before the prepend. Without this
    /// the user sees a vertical jump whenever the topmost-visible
    /// bubble wasn't already at viewport top at expand time.
    @State private var pendingAnchorRestore: (id: String, screenY: CGFloat)? = nil
    /// Last-observed spinner visibility. Used only by the targeted
    /// spinner diag log — when either edge's visibility flips, we
    /// emit one line summarising the window state. Low-volume by
    /// design (transitions happen at most a few times per scroll
    /// session, not per frame).
    @State private var lastSpinnerState: (top: Bool, bottom: Bool) = (false, false)
    /// Last-emitted window tuple for `logWindowStateIfChanged`. Same
    /// transition-only pattern as `lastSpinnerState`. -1 sentinel
    /// means "not yet emitted" so the first call always fires.
    @State private var lastLoggedWindow: (start: Int, end: Int, total: Int) = (-1, -1, -1)
    /// Most recent observed scroll phase. Used to gate window
    /// expansion to settled scroll only — without this gate, a
    /// single user flick produces many `top-edge expand` triggers
    /// during the deceleration window, each landing the user at a
    /// different content-space position. With the gate, one
    /// flick = at most one expansion (fired when motion settles).
    @State private var scrollPhase: ScrollPhase = .idle
    /// Total turn count last observed by the follow-bottom rule. Used
    /// to detect "was the rendered window at the bottom edge before
    /// this update?". Required because `.onChange(of: count)` only
    /// gives us new value, not old — and we need to know whether the
    /// window's bottom matched the PREVIOUS total to decide whether to
    /// slide on growth. Reset on session entry alongside the window.
    @State private var lastSeenTotalTurns: Int = 0

    // MARK: - R1 Growing-Reply State
    //
    // After the user sends a message we drive the scroll through three
    // phases:
    //   .followBottom  — defaultScrollAnchor=.bottom; as the agent reply
    //                    grows, content stays pinned to bottom and the
    //                    user bubble drifts up the viewport.
    //   .lockedAtTop   — once the user bubble reaches the viewport top,
    //                    we flip the anchor off and proxy-scroll the
    //                    bubble to the top. Further growth extends the
    //                    agent reply off the bottom of the viewport.
    //   .idle          — no automatic anchoring. Triggered by manual
    //                    scroll, session going idle, or session switch.

    enum GrowMode { case idle, followBottom, lockedAtTop }

    @State private var growMode: GrowMode = .idle
    /// ChatMessage.id of the user bubble currently being tracked by R1.
    @State private var lockedMsgId: String? = nil
    /// Baseline of the largest user-message seq seen so far. R1 only
    /// triggers when a STRICTLY greater seq appears (i.e., the user just
    /// sent a new message — not on session switch / replay).
    @State private var lockedUserSeq: Int = 0
    /// During R1 .followBottom, set true the first tick we observe the
    /// new user bubble actually inside the viewport (topInViewport > 0).
    /// LOCK is gated on this so a stale scroll position carried over
    /// from a previous .lockedAtTop session can't trigger an immediate
    /// re-LOCK before the bubble has grown into view.
    @State private var sawBubbleBelowTop: Bool = false
    /// Whether the sticky overlay bubble is user-expanded past its
    /// max collapsed height. Resets each time the candidate changes.
    @State private var stickyExpanded: Bool = false
    /// ScrollPosition binding used for the tap-to-restore action so we
    /// can land the tapped user bubble's top exactly at the viewport
    /// top — the precise threshold where the natural pill-opacity rule
    /// hides the pill and reveals the original bubble in chat.
    ///
    /// **Phase A pre-positioning:** initialized with `.scrollTo(id:
    /// "chat-bottom", anchor: .bottom)` so the very first paint of the
    /// ScrollView lands at the chat-bottom sentinel. Without this, the
    /// `.scrollPosition($pos, anchor: .top)` modifier shadows
    /// `defaultScrollAnchor(.bottom)` and the initial render starts at
    /// y=0 (top of content), forcing the entry-scroll task to animate
    /// down to the bottom — visible as a "scroll into place" delay
    /// when opening a session.
    @State private var chatScrollPosition: ScrollPosition = {
        var pos = ScrollPosition()
        pos.scrollTo(id: "chat-bottom", anchor: .bottom)
        return pos
    }()

    // MARK: - Idle anchor lock
    //
    // Once a turn completes (sessionIdle), the latest user bubble's
    // current screen Y is captured into `anchoredScreenY`. From then
    // on, every layout pass that moves the bubble (e.g. new tool call
    // arriving in idle mode, expand/collapse of post-bubble content)
    // is immediately compensated so the bubble's screen position
    // stays put. The lock releases on:
    //   • user scrolling (`.onScrollPhaseChange .interacting`)
    //   • a new user message (R1 followBottom takes over)
    //   • session switch (the `.task(id:)` block resets state)
    //
    // While R1 is active (`growMode != .idle`) the lock is NOT
    // enforced — streaming owns scroll.

    /// id of the user bubble whose screen Y is being held fixed.
    @State private var anchoredUserMsgId: String? = nil
    /// Screen-space Y at which `anchoredUserMsgId`'s bubble top is
    /// being held. Computed as `bubble.minY - scrollOffsetY` at the
    /// moment the lock was acquired.
    @State private var anchoredScreenY: CGFloat? = nil

    private var sessionStore: SessionStore { appState.sessionStore }
    private var messageStore: MessageStore { appState.messageStore }
    private var session: SessionInfo? { sessionStore.sessions[sessionId] }

    private var isDeviceOnline: Bool {
        guard let session else { return false }
        return appState.deviceStore.devices[session.deviceId]?.online ?? false
    }

    /// Pending permissions for this session (filtered from global map).
    private var permissions: [PendingPermission] {
        messageStore.permissionsForSession(sessionId)
    }

    /// Pending questions for this session.
    private var questions: [PendingQuestion] {
        messageStore.questionsForSession(sessionId)
    }

    /// Messages for this session. Pending permissions stay inline so the user
    /// sees the request in chat history, mirroring how pending questions behave.
    private var filteredMessages: [ChatMessage] {
        messageStore.messages[sessionId] ?? []
    }

    /// Whether older content can be brought into view — either by
    /// expanding the render window into already-in-memory turns
    /// (`hasFoldedTurns`) or by fetching more from tentacle
    /// (`firstSeq > 1`). Used by the auto-load rule.
    private var hasOlderMessages: Bool {
        if hasFoldedTurns { return true }
        let seqs = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }
        guard let first = seqs.min() else { return false }
        return first > 1
    }

    /// Whether to show the top spinner row. True whenever more
    /// content exists ABOVE the rendered window — either folded
    /// in-memory turns (`hasFoldedTurnsAbove`) or older history
    /// still in tentacle (`firstSeq > 1`). Acts as a persistent
    /// "more above" visual indicator AND as the trigger zone for
    /// top-edge auto-load.
    private var showTopSpinner: Bool {
        if hasFoldedTurnsAbove { return true }
        let seqs = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }
        guard let first = seqs.min() else { return false }
        return first > 1
    }

    /// Whether to show the bottom spinner row. True whenever folded
    /// in-memory turns exist BELOW the rendered window. Mirror of
    /// `showTopSpinner`. Hidden when the window includes the latest
    /// turn (no more below to reveal).
    private var showBottomSpinner: Bool {
        hasFoldedTurnsBelow
    }

    /// Whether folded turns exist ABOVE the rendered window — i.e.,
    /// in-memory turns at indices below `renderWindowStartIdx`.
    private var hasFoldedTurnsAbove: Bool {
        renderWindowStartIdx > 0
    }

    /// Whether folded turns exist BELOW the rendered window — i.e.,
    /// in-memory turns at indices ≥ `renderWindowStartIdx +
    /// renderedTurnCount`.
    private var hasFoldedTurnsBelow: Bool {
        renderWindowStartIdx + renderedTurnCount < cachedAllTurnCount
    }

    /// Whether the rendered window is smaller than the in-memory
    /// turn count — i.e., older turns exist in memory but not in
    /// the SwiftUI tree. Either above OR below the window counts.
    private var hasFoldedTurns: Bool {
        hasFoldedTurnsAbove || hasFoldedTurnsBelow
    }

    /// Session streaming content.
    private var streaming: String? {
        sessionStore.streamingContent[sessionId]
    }

    /// **Cached** result of `groupMessagesIntoTurns(filteredMessages)`.
    /// Recomputed only when `filteredMessages.count` changes (via the
    /// `.onChange` handler) — never on every body invocation.
    /// `groupMessagesIntoTurns` is O(n) over all in-memory messages
    /// (2000+ in long sessions) and accessing it as a plain computed
    /// property caused the main thread to stall long enough for
    /// WebSocket heartbeats to time out — symptom: opening the
    /// session disconnected the relay.
    @State private var cachedRawTurns: [TurnItem] = []
    /// Mirror of `cachedRawTurns.count + (streaming-extra-turn ? 1 : 0)`
    /// for cheap O(1) reads from helpers that only need the total turn
    /// count (`hasFoldedTurnsBelow`, `handleTopEdgeExpand`,
    /// `handleBottomEdgeExpand`, `followBottomOnNewTurns`). Kept in
    /// sync with `allGroupedTurns` in `refreshGroupingCache`.
    @State private var cachedAllTurnCount: Int = 0
    /// First turn id observed in the previous `cachedRawTurns`. When
    /// the cache rebuilds and the new first turn id differs, older
    /// turns were prepended (tentacle backfill). The prepend-follow
    /// uses this to shift `renderWindowStartIdx` forward so the
    /// rendered slice keeps pointing at the same physical turns —
    /// otherwise the user's view teleports to ancient history.
    @State private var lastKnownFirstTurnId: String? = nil

    /// Full grouped turn list (all in-memory messages + a synthetic
    /// streaming turn appended if needed). Reads the cached value
    /// instead of re-grouping per access — see `cachedRawTurns`.
    private var allGroupedTurns: [TurnItem] {
        let raw = cachedRawTurns
        // Streaming-turn appendage is cheap: just a conditional
        // append; no message walking. Done at read time so it stays
        // live without invalidating the (expensive) raw cache.
        guard streaming != nil else { return raw }
        if let last = raw.last, case .turn(let turn) = last, turn.finalMessage == nil {
            return raw
        }
        return raw + [.turn(Turn(id: "streaming", userMessage: nil, thinkingMessages: [], finalMessage: nil, isActive: true))]
    }

    /// Grouped turn items, windowed via the sliding-window state.
    /// Slice = `allGroupedTurns[renderWindowStartIdx ..<
    /// renderWindowStartIdx + renderedTurnCount]`. Bounds-clamped so
    /// late state updates can't crash even if `renderWindowStartIdx`
    /// drifts past `cachedAllTurnCount`.
    ///
    /// Computed cheaply: slices the cached raw array directly, and
    /// appends the synthetic streaming turn only if the slice's end
    /// reaches past the raw count. Avoids the O(n) array copy that
    /// `allGroupedTurns` does in the streaming case.
    private var grouped: [TurnItem] {
        let raw = cachedRawTurns
        let total = cachedAllTurnCount
        guard total > 0 else { return [] }
        let start = max(0, min(renderWindowStartIdx, total))
        let end = min(start + renderedTurnCount, total)
        guard start < end else { return [] }
        let rawSliceEnd = min(end, raw.count)
        var result: [TurnItem] = []
        if start < rawSliceEnd {
            result = Array(raw[start..<rawSliceEnd])
        }
        if end > raw.count {
            // Slice extends into the synthetic streaming turn.
            result.append(.turn(Turn(id: "streaming", userMessage: nil, thinkingMessages: [], finalMessage: nil, isActive: true)))
        }
        return result
    }

    /// Clamp a desired window `[desiredStart, desiredEnd)` to valid
    /// bounds within `cachedRawTurns`. In the idle-bounded turn model
    /// every grouped item (either a complete `.turn` or a true
    /// `.standalone` session event) is a self-contained render unit,
    /// so the only adjustment needed is clamping — there's no
    /// half-turn boundary to snap away from.
    ///
    /// Returns the clamped (start, end) tuple. The caller assigns
    /// `renderWindowStartIdx = start` and
    /// `renderedTurnCount = end - start`.
    private func snapWindow(desiredStart: Int, desiredEnd: Int) -> (start: Int, end: Int) {
        let total = cachedRawTurns.count
        let end = max(0, min(total, desiredEnd))
        let start = max(0, min(desiredStart, end))
        return (start, end)
    }

    /// Whether the session is idle (last message is idle type).
    private var sessionIdle: Bool {
        guard let last = filteredMessages.last else { return true }
        return last.type == "idle"
    }

    /// Last user-side message (user_message or send_input), used as the
    /// scroll target for R3-unread and R1/R2 anchoring.
    private var lastUserMessage: ChatMessage? {
        filteredMessages.last(where: { $0.type == "user_message" || $0.type == "send_input" })
    }

    /// Is this session currently fetching messages from tentacle?
    /// Driven by MessageProvider via SessionStore.loadingSessions.
    private var isLoading: Bool {
        sessionStore.loadingSessions.contains(sessionId)
    }

    /// True when we have any cached messages OR we know we've reached
    /// the very beginning of the conversation. Used by the State-A
    /// center-spinner gate: while false AND we're loading, the chat
    /// list + compose footer are hidden and we show a single centered
    /// spinner. The tentacle's turn-aware endpoint guarantees the
    /// first batch always contains the latest turn, so this flag
    /// flips true as soon as the first batch arrives.
    private var latestTurnLoaded: Bool {
        !filteredMessages.isEmpty
    }

    /// State-A: empty + loading. Show centered spinner, hide the
    /// scroll list and the compose footer.
    private var showCenterLoading: Bool {
        !latestTurnLoaded && isLoading
    }

    var body: some View {
        ScrollViewReader { proxy in
            Group {
                if showCenterLoading {
                    centerLoadingView
                } else {
                    scrollableMessages(proxy: proxy)
                        .overlay(alignment: .top) {
                            stickyUserOverlay(proxy: proxy)
                        }
                        .overlay(alignment: .bottomTrailing) {
                            jumpToLatestButton
                        }
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            // Show the compose area whenever the tentacle
                            // device is on file as online. We intentionally
                            // do NOT gate on `appState.isFullyOnline` —
                            // relay blips are short, the WS layer queues
                            // outbound frames (200-frame cap, 60s TTL),
                            // and the input itself surfaces a hint when
                            // sending would not be live. Yanking the
                            // input mid-typing on every reconnect would
                            // be far more disruptive than queueing for
                            // a few hundred ms.
                            if isDeviceOnline {
                                bottomInputArea
                            }
                        }
                }
            }
            .background(Color.surfacePrimary)
        }
    }

    /// Floating circular button (bottom-trailing) that jumps to the
    /// latest content. Visible only when the rendered window doesn't
    /// already include the latest turn — i.e., the user is in
    /// history and the bottom spinner would otherwise be visible
    /// too. Tapping snaps the window to the bottom and scrolls to
    /// the chat-bottom sentinel in one shot, so the user doesn't
    /// have to repeatedly swipe-down through 50+ turns.
    @ViewBuilder
    private var jumpToLatestButton: some View {
        if hasFoldedTurnsBelow {
            Button(action: { jumpToLatest() }) {
                Image(systemName: "chevron.down")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(
                        Circle().fill(Color.krakiPrimary)
                    )
                    .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
            }
            .padding(.trailing, 16)
            .padding(.bottom, 12)
            .transition(.scale.combined(with: .opacity))
        }
    }

    // MARK: - State-A center loading

    private var centerLoadingView: some View {
        VStack {
            Spacer()
            ProgressView()
                .controlSize(.large)
                .tint(.krakiPrimary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Scrollable Messages

    private func scrollableMessages(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            VStack(spacing: 12) {
                // Top spinner row — persistent visual indicator that
                // more content exists ABOVE the rendered window.
                // Visible whenever `hasFoldedTurnsAbove` (folded
                // in-memory turns) OR `firstSeq > 1` (older history
                // still in tentacle). Hidden only at session start
                // (no more to load above). Acts as both an indicator
                // and the layout space for `topSpinnerHeight +
                // topSpinnerSlop` threshold in `maybeAutoLoadOlder`.
                if showTopSpinner {
                    HStack {
                        Spacer()
                        ProgressView()
                            .controlSize(.small)
                            .tint(.krakiPrimary)
                        Spacer()
                    }
                    .frame(height: Self.topSpinnerHeight)
                    .id("top-spinner")
                }

                // Message items
                ForEach(Array(grouped.enumerated()), id: \.element.id) { idx, item in
                    switch item {
                    case .standalone(let msg):
                        standaloneRow(msg)

                    case .turn(let turn):
                        let isLastTurn = idx == grouped.count - 1
                        let hasStreaming = isLastTurn && streaming != nil
                        let turnId = turn.id

                        // Each idle-bounded turn renders as: optional
                        // leading user bubble (the message that opened
                        // the turn) followed by the agent activity
                        // bubble. Both render here so the turn is a
                        // self-contained unit in the scroll list.
                        Group {
                            if let userMsg = turn.userMessage {
                                standaloneRow(userMsg)
                            }

                            if let final = turn.finalMessage, !hasStreaming {
                                // Turn complete: final bubble with thinking history inside
                                MessageBubbleView(
                                    message: final,
                                    agent: session?.agent ?? "",
                                    turnImages: collectTurnImages(turn.thinkingMessages),
                                    thinkingHistory: turn.thinkingMessages,
                                    historyExpanded: Binding(
                                        get: { expandedTurns.contains(turnId) },
                                        set: { if $0 { expandedTurns.insert(turnId) } else { expandedTurns.remove(turnId) } }
                                    )
                                )
                                .id(messageScrollId(final))
                            } else if !turn.thinkingMessages.isEmpty || hasStreaming {
                                // Turn in progress
                                let latestMsg = turn.thinkingMessages.last(where: { $0.type == "agent_message" })
                                let hasMessage = latestMsg?.content != nil && latestMsg?.content?.isEmpty == false
                                let hasStreamingContent = hasStreaming && streaming?.isEmpty == false
                                let hasTools = turn.thinkingMessages.contains(where: { $0.type == "tool_start" || $0.type == "tool_complete" })

                                if hasMessage || hasStreamingContent || hasTools {
                                    MessageBubbleView(
                                        message: latestMsg ?? ChatMessage(
                                            type: "agent_message",
                                            seq: 0,
                                            sessionId: sessionId,
                                            deviceId: nil,
                                            timestamp: nil,
                                            payload: [:]
                                        ),
                                        agent: session?.agent ?? "",
                                        thinkingHistory: turn.thinkingMessages,
                                        historyExpanded: Binding(
                                            get: { expandedTurns.contains(turnId) },
                                            set: { if $0 { expandedTurns.insert(turnId) } else { expandedTurns.remove(turnId) } }
                                        ),
                                        streamingText: hasStreaming ? streaming : nil
                                    )
                                    // Tag the in-progress turn with a scroll id
                                    // when it has a usable agent_message — R3
                                    // priority 3 ("last agent_message at top")
                                    // targets exactly this id. Without the tag,
                                    // an unread session whose latest turn is
                                    // still mid-stream loses its scroll target
                                    // and falls back to defaultScrollAnchor.
                                    .id(latestMsg.map { messageScrollId($0) } ?? "turn-\(turnId)")
                                }
                            }
                        }
                    }
                }

                // Bottom spinner row — persistent visual indicator that
                // more content exists BELOW the rendered window
                // (folded in-memory turns). Hidden when window
                // includes the latest turn. Mirror of the top spinner.
                if showBottomSpinner {
                    HStack {
                        Spacer()
                        ProgressView()
                            .controlSize(.small)
                            .tint(.krakiPrimary)
                        Spacer()
                    }
                    .frame(height: Self.topSpinnerHeight)
                    .id("bottom-spinner")
                }

                // Bottom anchor
                Color.clear
                    .frame(height: 1)
                    .id("chat-bottom")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 16)
            .coordinateSpace(name: "chat")
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
        .defaultScrollAnchor(currentScrollAnchor)
        .scrollPosition($chatScrollPosition, anchor: .top)
        .onScrollGeometryChange(for: ChatScrollMetrics.self) { geo in
            ChatScrollMetrics(
                offsetY: geo.contentOffset.y + geo.contentInsets.top,
                viewportHeight: geo.containerSize.height
                    - geo.contentInsets.top - geo.contentInsets.bottom,
                insetTop: geo.contentInsets.top,
                insetBottom: geo.contentInsets.bottom,
                contentHeight: geo.contentSize.height
            )
        } action: { oldM, m in
            // Single observable mutation per scroll event. Helpers
            // that themselves mutate scroll position (checkLockTransition's
            // proxy.scrollTo, maybeAutoLoadOlder's renderedTurnCount bump)
            // are deferred to the next runloop turn so they don't
            // re-fire this action inside the same render pass — which is
            // what produced the "tried to update multiple times per frame"
            // runtime warning.
            scrollMetrics = m
            if Self.diagScrollCascade, pendingAnchorRestore != nil,
               abs(m.offsetY - oldM.offsetY) > 1 {
                KLog.d("📏geom WHILE-PENDING offsetY=\(oldM.offsetY)→\(m.offsetY) Δ=\(m.offsetY - oldM.offsetY) contentH=\(oldM.contentHeight)→\(m.contentHeight)")
            }
            // Viewport shrank (keyboard came up, or the input box grew
            // an extra line, or any other safe-area inset change) →
            // pin to chat-bottom so the latest message stays visible
            // above the new compose / keyboard region. Always pin,
            // even when the user was scrolled up: the keyboard
            // appearing means they're focusing the input to send a
            // new message, and they expect that new message + the
            // latest reply visible right above their typing.
            let viewportShrunk = m.viewportHeight + 1 < oldM.viewportHeight
            Task { @MainActor in
                checkLockTransition(proxy: proxy)
                maybeAutoLoadOlder()
                if viewportShrunk && growMode == .idle {
                    scrollToBottomInstant(proxy: proxy)
                }
            }
        }
        .onScrollPhaseChange { _, newPhase in
            // Any direct user contact with the scroll view ends R1
            // AND releases the idle anchor lock so the user can scroll
            // freely from this point on.
            if newPhase == .interacting {
                if growMode != .idle {
                    growMode = .idle
                }
                releaseIdleAnchor()
            }
            scrollPhase = newPhase
            // When scroll fully settles, give the expansion rule one
            // chance to fire. This is the "expansion on settled
            // scroll" gate: cascading expansions during deceleration
            // are suppressed; instead a single fire happens when the
            // user's motion stops.
            if newPhase == .idle {
                Task { @MainActor in
                    maybeAutoLoadOlder()
                }
            }
        }
        .onPreferenceChange(UserBubbleFramesKey.self) { newFrames in
            // Plain VStack lays out every row eagerly, so `newFrames`
            // always contains a fresh frame for every user bubble.
            // Replace (don't merge) — merging causes stale-low minY
            // values to linger after older messages are prepended,
            // which then wrongly satisfy `f.minY <= scrollOffsetY`
            // and surface a sticky candidate that shouldn't exist.
            userBubbleFrames = newFrames
            // Consume a pending anchor restore if one was queued by
            // the previous top-edge expansion. By now SwiftUI has laid
            // out the new turns and updated the anchor bubble's
            // content-space minY in `newFrames`. We compute
            // `newMinY - screenY` to land the bubble at the same
            // screen position as before the prepend — preserving the
            // user's view across expansion.
            if Self.diagScrollCascade, let pending = pendingAnchorRestore {
                let f = newFrames[pending.id]
                KLog.d("📐prefFire frames=\(newFrames.count) pendingId=user-\(pending.id.suffix(8)) framePresent=\(f != nil) frameMinY=\(f?.minY ?? -999) frameH=\(f?.height ?? -999) offsetY=\(scrollOffsetY)")
            }
            if let pending = pendingAnchorRestore,
               let newFrame = newFrames[pending.id],
               newFrame.height > 0 {
                let targetY = newFrame.minY - pending.screenY
                chatScrollPosition.scrollTo(y: max(0, targetY))
                logAnchorRestore(id: pending.id,
                                 oldScreenY: pending.screenY,
                                 newMinY: newFrame.minY,
                                 targetY: max(0, targetY))
                pendingAnchorRestore = nil
            }
            checkLockTransition(proxy: proxy)
            enforceIdleAnchor()
        }
        .onChange(of: lastUserMessage?.seq ?? 0) { _, newSeq in
            // A new user message starts a fresh turn — R1 followBottom
            // will own scroll until the turn settles, so drop any
            // existing idle anchor.
            releaseIdleAnchor()
            handleNewUserMessage(proxy: proxy, seq: newSeq)
        }
        .onChange(of: streaming) { oldVal, newVal in
            checkLockTransition(proxy: proxy)
            // Streaming start/stop toggles whether `allGroupedTurns`
            // appends the synthetic placeholder turn. Refresh the
            // count so `cachedAllTurnCount` stays in sync — but only
            // on start/stop transitions, not per text delta.
            let was = oldVal != nil
            let now = newVal != nil
            if was != now {
                refreshGroupingCache()
            }
        }
        .onChange(of: filteredMessages.count) { _, _ in
            refreshGroupingCache()
            maybeAutoLoadOlder()
            followBottomOnNewTurns()
            logWindowStateIfChanged(reason: "msg-count-change")
            logSpinnerStateIfChanged(reason: "msg-count-change")
        }
        .onChange(of: sessionIdle) { _, idle in
            // Turn complete — release the R1 lock so the next user
            // message can trigger a fresh followBottom phase, AND
            // capture the current user bubble's screen Y as the
            // idle anchor so subsequent layout changes (new tool
            // calls, expansions) leave the bubble's position
            // visually fixed.
            if idle && growMode != .idle {
                growMode = .idle
            }
            if idle {
                acquireIdleAnchor()
            }
        }
        .task(id: sessionId) {
            // Reset anchor state across session switches.
            releaseIdleAnchor()
            await performEntryScroll(proxy: proxy)
        }
    }

    /// Default scroll anchor for the message list.
    /// - `.bottom` before R3 has run so a cold launch lands at the
    ///   bottom for read sessions (R3 overrides for unread).
    /// - `nil` otherwise so the scroll position is preserved across
    ///   content changes (no auto-following while the user is reading).
    ///
    /// Note: we deliberately do NOT toggle this to `.bottom` during
    /// R1 followBottom. Toggling it mid-session causes SwiftUI to
    /// re-anchor scroll position, which in combination with the
    /// keyboard dismissal animation produces a jarring 1500-2000pt
    /// upward jump (user bubble vanishes off-screen). R1 instead
    /// drives the scroll explicitly via `proxy.scrollTo("chat-bottom")`
    /// on every layout/streaming tick, with animations disabled so
    /// the bottom stays pinned visually.
    private var currentScrollAnchor: UnitPoint? {
        if !didInitialScroll { return .bottom }
        return nil
    }

    // MARK: - Auto-load older messages / window sliding

    /// Sliding-window auto-load. Two trigger zones; called from the
    /// scroll-metrics action.
    ///
    /// **Top edge** (scrollOffsetY < topSpinnerHeight + topSpinnerSlop):
    ///   1. If there are folded turns ABOVE the rendered window:
    ///      shift the window up. If size < maxRenderedTurns, also
    ///      grow it; otherwise drop equivalent turns from the bottom
    ///      (slide).
    ///   2. Else if `firstSeq > 1` (more network history): fetch.
    ///
    /// **Bottom edge** (scrollOffsetY + viewportHeight >
    /// chatContentHeight - bottomEdgeSlop):
    ///   - If there are folded turns BELOW: slide the window down.
    ///     Drops top turns, adds bottom turns. R1 is guaranteed not
    ///     to be active here because user-scroll releases R1.
    ///
    /// A 400ms debounce on window slides stops `onScrollGeometryChange`
    /// from cascading shifts in a single render pass.
    ///
    /// All slides are gated on `growMode == .idle` so an active R1
    /// (followBottom or lockedAtTop) doesn't have its anchored bubble
    /// dropped from the rendered set.
    /// Compile-time diag switch for the scroll-cascade investigation.
    /// Flip to `false` when done. Logs include: every gate evaluation,
    /// every state mutation, every preference fire, every scroll
    /// offset transition while a restore is pending.
    private static let diagScrollCascade: Bool = false

    /// Emit one log line when either spinner's visibility flips. Low
    /// volume by design — fires at most a few times per scroll session.
    /// Use to debug "spinner stuck visible" / "load not firing" without
    /// the per-frame log flood that explodes CPU.
    private func logSpinnerStateIfChanged(reason: String) {
        let top = hasFoldedTurnsAbove
        let bottom = hasFoldedTurnsBelow
        guard top != lastSpinnerState.top || bottom != lastSpinnerState.bottom else { return }
        let total = cachedAllTurnCount
        let start = renderWindowStartIdx
        let end = start + renderedTurnCount
        // Describe what's at the window's last raw position (helps
        // confirm "end lands after a turn" invariant).
        let raw = cachedRawTurns
        let tailType: String = {
            guard end > 0, end <= raw.count else { return "?" }
            switch raw[end - 1] {
            case .standalone(let m): return "standalone(\(m.type))"
            case .turn: return "turn"
            }
        }()
        let headType: String = {
            guard start < raw.count else { return "?" }
            switch raw[start] {
            case .standalone(let m): return "standalone(\(m.type))"
            case .turn: return "turn"
            }
        }()
        // Always emit via NSLog so this single line survives KLog being
        // gated off — it's the diagnostic that matters when the user
        // reports a stuck spinner.
        let line = "🌀spinner top=\(top)→\(top != lastSpinnerState.top ? "FLIP" : "—") bottom=\(bottom)→\(bottom != lastSpinnerState.bottom ? "FLIP" : "—") win=[\(start)..\(end))/\(total) head=\(headType) tail=\(tailType) reason=\(reason)"
        NSLog("🦑 %@", line)
        print("🦑", line)
        lastSpinnerState = (top, bottom)
    }

    /// Emit one line when the rendered window tuple `[start..end)/total`
    /// changes. Transition-only so the CPU stays calm even when
    /// scrolling continuously — `renderWindowStartIdx` /
    /// `renderedTurnCount` only mutate inside the debounced edge
    /// handlers, `jumpToLatest`, `followBottomOnNewTurns`, and
    /// `performEntryScroll`, so this fires a handful of times per
    /// session at most.
    private func logWindowStateIfChanged(reason: String) {
        let start = renderWindowStartIdx
        let end = start + renderedTurnCount
        let total = cachedAllTurnCount
        guard start != lastLoggedWindow.start
              || end != lastLoggedWindow.end
              || total != lastLoggedWindow.total else { return }
        let foldedAbove = start
        let foldedBelow = max(0, total - end)
        let line = "🪟win=[\(start)..\(end))/\(total) Δstart=\(start - max(0, lastLoggedWindow.start)) Δend=\(end - max(0, lastLoggedWindow.end)) foldedAbove=\(foldedAbove) foldedBelow=\(foldedBelow) reason=\(reason)"
        NSLog("🦑 %@", line)
        print("🦑", line)
        lastLoggedWindow = (start, end, total)
    }

    /// Emit one line per edge-fire attempt (top or bottom). Fires at
    /// most every `windowExpandDebounce` (400ms) per edge so this is
    /// inherently low-volume. Captures the scroll position + anchor
    /// info that determined the fire, so we can see whether the rule
    /// is triggering at the right times.
    private func logEdgeFire(edge: String, fired: Bool, reason: String,
                             anchorId: String?, anchorScreenY: CGFloat?) {
        let line = "🔁\(edge) fired=\(fired) reason=\(reason) offsetY=\(Int(scrollOffsetY)) contentH=\(Int(chatContentHeight)) viewportH=\(Int(viewportHeight)) anchor=\(anchorId?.suffix(8).description ?? "nil") screenY=\(anchorScreenY.map { Int($0) }.map(String.init) ?? "nil") foldedAbove=\(hasFoldedTurnsAbove) foldedBelow=\(hasFoldedTurnsBelow)"
        NSLog("🦑 %@", line)
        print("🦑", line)
    }

    /// Emit one line when a pending anchor restore is consumed in
    /// `onPreferenceChange(UserBubbleFramesKey)`. One fire per
    /// debounced edge expansion, so volume = edge volume.
    private func logAnchorRestore(id: String, oldScreenY: CGFloat,
                                  newMinY: CGFloat, targetY: CGFloat) {
        let line = "🪝anchorRestore id=user-\(id.suffix(8)) oldScreenY=\(Int(oldScreenY)) newMinY=\(Int(newMinY)) → scrollY=\(Int(targetY))"
        NSLog("🦑 %@", line)
        print("🦑", line)
    }

    private func phaseDescription(_ phase: ScrollPhase) -> String {
        switch phase {
        case .idle: return "idle"
        case .tracking: return "tracking"
        case .interacting: return "interacting"
        case .decelerating: return "decelerating"
        case .animating: return "animating"
        @unknown default: return "?"
        }
    }

    /// Is the user bubble with this id currently mounted in the
    /// rendered window? Used only by diag logs — checks whether the
    /// captured anchor will produce a fresh frame in the next
    /// `onPreferenceChange` (it won't if it's been folded out).
    private func isUserBubbleInRenderedWindow(_ id: String) -> Bool {
        // The rendered window covers turns at index
        // [renderWindowStartIdx, renderWindowStartIdx + renderedTurnCount).
        // A user bubble's id is the turn's user_message id; we don't
        // need to scan the cache — `userBubbleFrames` is populated
        // only by rendered rows, so presence-in-frames-dict is
        // equivalent to presence-in-window.
        return userBubbleFrames[id] != nil
    }

    private func maybeAutoLoadOlder() {
        // Don't auto-load until entry-scroll has positioned us.
        guard didInitialScroll else { return }
        // Don't slide while R1 owns scroll — its anchor bubble must
        // stay in the rendered window.
        guard growMode == .idle else { return }

        // Top-edge: expand window upward. Fires whenever the spinner
        // is in (or near) the viewport — no scroll-phase gate. To
        // prevent inertia from carrying the user past the rendered
        // top while we're still loading, `handleTopEdgeExpand` halts
        // momentum by programmatically pinning scroll to the
        // captured anchor before mutating the window.
        let topThreshold = Self.topSpinnerHeight + Self.topSpinnerSlop
        if scrollOffsetY < topThreshold {
            if Self.diagScrollCascade {
                KLog.d("🔝gate offsetY=\(scrollOffsetY) phase=\(phaseDescription(scrollPhase)) growMode=\(growMode) hasAbove=\(hasFoldedTurnsAbove) pendingRestore=\(pendingAnchorRestore?.id.suffix(8) ?? "nil")")
            }
            handleTopEdgeExpand()
            return
        }

        // Bottom-edge: slide window downward. Same semantic as top —
        // fires on spinner visible regardless of scroll phase.
        //
        // Use `effectiveContentBottom` (= contentHeight − insetBottom)
        // not `contentHeight` directly: SwiftUI's `geo.contentSize.height`
        // includes the `.safeAreaInset(.bottom)` region as phantom
        // scrollable space that the user can never actually reach.
        // Threshold against raw `contentHeight` is unreachable on any
        // device where the input bar + safe area is taller than the
        // slop — i.e., always.
        let viewportBottomY = scrollOffsetY + viewportHeight
        let bottomThreshold = effectiveContentBottom - Self.bottomEdgeSlop
        if hasFoldedTurnsBelow && viewportBottomY > bottomThreshold {
            handleBottomEdgeExpand()
            return
        }
        // Diagnostic: log near-bottom-edge near-misses so we can
        // see when conditions aren't met during apparent-stuck cases.
        if hasFoldedTurnsBelow && scrollPhase == .idle {
            let gap = effectiveContentBottom - viewportBottomY
            if gap < 200 {
                KLog.d("🔻bottom-edge near-miss gap=\(gap) (viewportBottomY=\(viewportBottomY) effectiveBottom=\(effectiveContentBottom) insetBottom=\(chatScrollInsetBottom) threshold=\(bottomThreshold))")
            }
        }
    }

    /// Top-edge expansion: bring older content into view. Single
    /// debounced entry point — does not branch on memory-vs-network;
    /// the provider's `ensureOlderLoaded` hides that decision.
    ///
    /// Each fire:
    ///   1. Captures the topmost-visible user bubble + screen Y and
    ///      pins scroll to it (halts inertia, queues an
    ///      `pendingAnchorRestore`).
    ///   2. Slides the local rendered window upward if folded turns
    ///      exist above it. Window grows up to `maxRenderedTurns`
    ///      then slides (drops `renderExpandStep` from END).
    ///   3. Asks the provider to ensure messages older than
    ///      `firstSeq` are loaded. Provider no-ops if memory already
    ///      has them, else fetches from tentacle. Backfill arrives
    ///      asynchronously and triggers `msg-count-change`, which
    ///      `applyPrependFollow` translates into a window-index
    ///      shift so the rendered slice keeps showing the same
    ///      physical turns.
    private func handleTopEdgeExpand() {
        let now = Date()
        if let last = lastWindowExpansion,
           now.timeIntervalSince(last) < Self.windowExpandDebounce {
            logEdgeFire(edge: "🔝top", fired: false, reason: "debounced",
                        anchorId: nil, anchorScreenY: nil)
            return
        }
        lastWindowExpansion = now

        // 1. Anchor capture + momentum halt.
        let anchorCapture: (id: String, screenY: CGFloat)? = {
            guard let id = topmostVisibleUserBubbleId(),
                  let frame = userBubbleFrames[id] else { return nil }
            let screenY = frame.minY - scrollOffsetY
            return (id, screenY)
        }()
        if let cap = anchorCapture {
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) {
                chatScrollPosition.scrollTo(id: cap.id, anchor: UnitPoint(x: 0, y: cap.screenY / max(1, viewportHeight)))
            }
        }

        // 2. Local window slide (if folded turns exist above).
        var slid = false
        if hasFoldedTurnsAbove {
            let total = cachedAllTurnCount
            let currentEnd = renderWindowStartIdx + renderedTurnCount
            let desiredStart = max(0, renderWindowStartIdx - Self.renderExpandStep)
            let isGrowingPhase = renderedTurnCount < Self.maxRenderedTurns
            let desiredEnd: Int
            if isGrowingPhase {
                desiredEnd = min(total, currentEnd)
            } else {
                // At cap → drop `renderExpandStep` from END so the
                // window can shift up. Without this the window is
                // frozen at the cap; symptom: "spinner keeps firing,
                // nothing changes."
                desiredEnd = max(desiredStart + 1, currentEnd - Self.renderExpandStep)
            }
            let (newStart, newEnd) = snapWindow(desiredStart: desiredStart, desiredEnd: desiredEnd)
            var finalStart = newStart
            if newEnd - finalStart > Self.maxRenderedTurns {
                finalStart = max(0, newEnd - Self.maxRenderedTurns)
            }
            renderWindowStartIdx = finalStart
            renderedTurnCount = max(1, newEnd - finalStart)
            slid = true
            if let cap = anchorCapture {
                pendingAnchorRestore = cap
            }
        }

        // 3. Ensure older messages are loaded (provider decides
        //    no-op vs tentacle fetch). Backfill arrival is handled
        //    by `applyPrependFollow` on msg-count-change.
        let firstSeq = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }.min() ?? Int.max
        var loadDispatched = false
        if firstSeq > 1 {
            loadDispatched = appState.messageProvider?.ensureOlderLoaded(
                sessionId: sessionId, beforeSeq: firstSeq) ?? false
            // If we're at the in-memory top (slid==false) and a
            // network fetch went out, still queue an anchor restore
            // so the prepend-follow can land on the same bubble.
            if !slid, let cap = anchorCapture, loadDispatched {
                pendingAnchorRestore = cap
            }
        }

        let reason: String
        if slid && loadDispatched      { reason = "slide+fetch" }
        else if slid                   { reason = "slide" }
        else if loadDispatched         { reason = "fetch beforeSeq=\(firstSeq)" }
        else if firstSeq <= 1          { reason = "at-session-start" }
        else                           { reason = "no-op" }
        logEdgeFire(edge: "🔝top", fired: slid || loadDispatched, reason: reason,
                    anchorId: anchorCapture?.id,
                    anchorScreenY: anchorCapture?.screenY)
        logWindowStateIfChanged(reason: "top-edge-expand")
        logSpinnerStateIfChanged(reason: "top-edge-expand")
    }

    /// Bottom-edge expansion: slide window down by `renderExpandStep`
    /// per debounced trigger, exposing the next folded-below turns.
    /// Symmetric with top-edge: capture the BOTTOMMOST visible user
    /// bubble + screen Y before mutation, queue a restore for after
    /// the next preference fire. The bottom anchor survives the slide
    /// because items dropped from the rendered tree come from the
    /// TOP of the window, never the bottom.
    private func handleBottomEdgeExpand() {
        let now = Date()
        if let last = lastWindowExpansion,
           now.timeIntervalSince(last) < Self.windowExpandDebounce {
            logEdgeFire(edge: "🔻bottom", fired: false, reason: "debounced",
                        anchorId: nil, anchorScreenY: nil)
            return
        }
        lastWindowExpansion = now

        // Anchor preservation (mirror of top-edge): capture the
        // bottommost-visible user bubble before sliding.
        let anchorCapture: (id: String, screenY: CGFloat)? = {
            guard let id = bottommostVisibleUserBubbleId(),
                  let frame = userBubbleFrames[id] else { return nil }
            let screenY = frame.minY - scrollOffsetY
            return (id, screenY)
        }()

        // Halt scroll momentum so the user doesn't blow past the
        // spinner mid-load. See `handleTopEdgeExpand` for the same
        // pattern at the other edge.
        if let cap = anchorCapture {
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) {
                chatScrollPosition.scrollTo(id: cap.id, anchor: UnitPoint(x: 0, y: cap.screenY / max(1, viewportHeight)))
            }
        }

        let total = cachedAllTurnCount
        // Bottom-edge slide: move the END forward by renderExpandStep,
        // then derive START from END - maxRenderedTurns.
        let currentEnd = renderWindowStartIdx + renderedTurnCount
        let desiredEnd = min(total, currentEnd + Self.renderExpandStep)
        let desiredStart = max(0, desiredEnd - Self.maxRenderedTurns)
        let (newStart, newEnd) = snapWindow(desiredStart: desiredStart, desiredEnd: desiredEnd)
        renderWindowStartIdx = newStart
        renderedTurnCount = max(1, newEnd - newStart)

        if let cap = anchorCapture {
            pendingAnchorRestore = cap
        }
        logEdgeFire(edge: "🔻bottom", fired: true, reason: "spinner-visible",
                    anchorId: anchorCapture?.id,
                    anchorScreenY: anchorCapture?.screenY)
        logWindowStateIfChanged(reason: "bottom-edge-slide")
        logSpinnerStateIfChanged(reason: "bottom-edge-slide")
    }

    /// Jump-to-latest: snap the window to the bottom and scroll to
    /// the chat-bottom sentinel. Used by the floating button when
    /// folded turns exist below the rendered window (i.e., the user
    /// is somewhere in history and wants to return to the latest).
    private func jumpToLatest() {
        let total = cachedAllTurnCount
        let desiredEnd = total
        let desiredStart = max(0, desiredEnd - Self.maxRenderedTurns)
        let (newStart, newEnd) = snapWindow(desiredStart: desiredStart, desiredEnd: desiredEnd)
        renderWindowStartIdx = newStart
        renderedTurnCount = max(1, newEnd - newStart)
        chatScrollPosition.scrollTo(id: "chat-bottom", anchor: .bottom)
        logWindowStateIfChanged(reason: "jump-to-latest")
        logSpinnerStateIfChanged(reason: "jump-to-latest")
    }

    /// When new turns arrive (live agent reply, user reply, tool
    /// events), keep the rendered window pinned to the bottom — but
    /// ONLY if the window was already at the bottom edge. This is the
    /// "auto-follow latest" behavior users expect: open a chat, see
    /// new messages appear in real time. If the user has scrolled up
    /// to explore history, the window stays put so we don't drag them
    /// out of context.
    ///
    /// The "was at bottom edge" check is `windowBottomBefore >=
    /// lastSeenTotalTurns`, where windowBottomBefore is
    /// `renderWindowStartIdx + renderedTurnCount` from the previous
    /// observation. `lastSeenTotalTurns` is updated at the end of this
    /// function so the next call's check uses the post-update total.
    /// Rebuild the grouping cache. Called once per
    /// `filteredMessages.count` change (and once at entry). Reading
    /// `cachedRawTurns` is then free.
    private func refreshGroupingCache() {
        let newRaw = groupMessagesIntoTurns(filteredMessages)
        let previousFirstTurnId = lastKnownFirstTurnId
        cachedRawTurns = newRaw
        // Count includes the synthetic streaming turn if present.
        let streamingTailNeeded: Bool = {
            guard streaming != nil else { return false }
            if let last = newRaw.last, case .turn(let turn) = last, turn.finalMessage == nil {
                return false
            }
            return true
        }()
        cachedAllTurnCount = newRaw.count + (streamingTailNeeded ? 1 : 0)
        applyPrependFollow(newRaw: newRaw, previousFirstTurnId: previousFirstTurnId)
        lastKnownFirstTurnId = newRaw.first?.id
    }

    /// When a refresh changes the FIRST turn id (older turns
    /// prepended by tentacle backfill), shift `renderWindowStartIdx`
    /// forward by the prepend delta so the rendered slice keeps
    /// pointing at the same physical turns the user was reading.
    /// Without this, the window indices stay literal (e.g. [0..7))
    /// but the underlying items at those indices silently swap to
    /// the newly-arrived ancient history — visible as a teleport.
    ///
    /// No-op when:
    ///   • Previous first id is nil (initial entry, nothing to follow).
    ///   • New first id == previous (no prepend, only tail growth or
    ///     in-place updates).
    ///   • Previous first id isn't found in the new list (unexpected;
    ///     bail rather than shift to a wrong position).
    private func applyPrependFollow(newRaw: [TurnItem], previousFirstTurnId: String?) {
        guard let prevId = previousFirstTurnId,
              let newFirstId = newRaw.first?.id,
              prevId != newFirstId else { return }
        guard let newIdx = newRaw.firstIndex(where: { $0.id == prevId }) else { return }
        guard newIdx > 0 else { return }
        let beforeStart = renderWindowStartIdx
        renderWindowStartIdx = min(beforeStart + newIdx, max(0, newRaw.count - 1))
        logWindowStateIfChanged(reason: "prepend-follow Δ=\(newIdx)")
    }

    private func followBottomOnNewTurns() {
        let newTotal = cachedAllTurnCount
        defer { lastSeenTotalTurns = newTotal }
        guard didInitialScroll, newTotal > lastSeenTotalTurns else { return }

        let windowBottomBefore = renderWindowStartIdx + renderedTurnCount
        guard windowBottomBefore >= lastSeenTotalTurns else {
            // Window was NOT at the bottom — user is exploring
            // history. Leave the window where it is.
            return
        }
        let beforeStart = renderWindowStartIdx
        let beforeCount = renderedTurnCount
        // If the top edge is already at the start of the session and
        // we have room to grow, prefer growing the window over sliding
        // (sliding would drop the very first turn the user wants to
        // see). Once we hit the cap, fall through to sliding.
        if renderWindowStartIdx == 0 && renderedTurnCount < Self.maxRenderedTurns {
            // Below cap — just grow to include the latest. End at total.
            let (newStart, newEnd) = snapWindow(desiredStart: 0, desiredEnd: newTotal)
            renderWindowStartIdx = newStart
            renderedTurnCount = max(1, newEnd - newStart)
        } else {
            // At cap — slide window forward to keep end at latest.
            let desiredEnd = newTotal
            let desiredStart = max(0, desiredEnd - Self.maxRenderedTurns)
            let (newStart, newEnd) = snapWindow(desiredStart: desiredStart, desiredEnd: desiredEnd)
            renderWindowStartIdx = newStart
            renderedTurnCount = max(1, newEnd - newStart)
        }
        if renderWindowStartIdx != beforeStart || renderedTurnCount != beforeCount {
            logWindowStateIfChanged(reason: "follow-bottom")
            logSpinnerStateIfChanged(reason: "follow-bottom")
        }
    }

    // MARK: - R2: Sticky User Bubble Overlay
    //
    // When the user scrolls back through a long agent reply, pin a
    // glass-backed copy of the user message of the CURRENT turn at the
    // top of the chat. The pill always shows whichever user bubble has
    // most recently scrolled above the viewport top (`stickyCandidate`).
    //
    // Opacity is driven purely by the distance from the viewport top
    // down to the NEXT user bubble (chronologically after the
    // candidate), i.e. how close the upcoming turn's bubble is to
    // reaching the pill's slot:
    //   distance ≥ stickyFadeEnd   → opacity 1   (next turn far below)
    //   distance ≤ stickyFadeStart → opacity 0   (next turn about to take over)
    //   between                    → linear ramp
    // If no next user bubble exists (candidate is the latest user
    // message), distance is infinite → opacity 1.
    //
    // When the candidate's own top has not yet crossed the viewport
    // top (`aboveAmount ≤ 0`, R1 lock or just-clipping), the pill is
    // suppressed entirely.
    //
    // The original row's opacity on the candidate row stays
    // `1 - stickyOpacity`, so pill and in-chat row cross-fade through
    // the window as the next turn approaches.

    /// Outer margin around the sticky overlay. Set to 0 so the pill's
    /// top edge sits exactly at the safe-area top — the same screen y
    /// as a user bubble whose top is just crossing above the viewport
    /// (`aboveAmount = 0`). Result: zero positional jump at the
    /// pill ↔ chat-bubble handoff.
    fileprivate static let stickyMargin: CGFloat = 0
    /// Pill begins to fade out once the next user bubble is this close
    /// to the viewport top.
    fileprivate static let stickyFadeStart: CGFloat = 120
    /// Pill stays at full opacity while the next user bubble is at
    /// least this far below the viewport top.
    fileprivate static let stickyFadeEnd: CGFloat = 240
    /// Pill fade-in range for the **manual-scroll** case. When the user
    /// scrolls past a turn, the pill ramps from 0 → 1 opacity as the
    /// candidate bubble's top drifts from 0 to this many points above
    /// the viewport top. Prevents a binary flip the moment the bubble
    /// crosses the top line.
    ///
    /// Note: this offset does NOT apply during R1 streaming — the
    /// streaming lock fires the moment the bubble touches the top line
    /// (`topInViewport <= 0`) and the bubble is then snapped + pinned
    /// to the top as the in-chat anchor. The pill stays hidden during
    /// streaming because `aboveAmount` is held at 0 by the snap.
    fileprivate static let stickyActivationOffset: CGFloat = 80

    /// User messages currently at-or-above the viewport top, ordered
    /// ascending by content y. The sticky candidate is the LAST element
    /// (most recent above-or-at). We use `<=` so the R1-locked bubble
    /// (sitting exactly at viewport top) is included; opacity then
    /// suppresses rendering until it actually moves above.
    private var stickyAboveCandidates: [ChatMessage] {
        let userMsgs = filteredMessages.filter {
            $0.type == "user_message" || $0.type == "send_input"
        }
        let scrolledAbove = userMsgs.filter { msg in
            guard let f = userBubbleFrames[msg.id] else { return false }
            return f.minY <= scrollOffsetY
        }
        return scrolledAbove.sorted { (a, b) in
            (userBubbleFrames[a.id]?.minY ?? 0) < (userBubbleFrames[b.id]?.minY ?? 0)
        }
    }

    /// The user message to render in the sticky overlay (most recent
    /// at-or-above the viewport top).
    private var stickyCandidate: ChatMessage? {
        stickyAboveCandidates.last
    }

    /// The next user message chronologically after `stickyCandidate`.
    /// Its viewport-top distance drives `stickyOpacity`.
    private var nextUserBubbleAfterCandidate: ChatMessage? {
        guard let candidate = stickyCandidate else { return nil }
        let userMsgs = filteredMessages.filter {
            $0.type == "user_message" || $0.type == "send_input"
        }
        guard let idx = userMsgs.firstIndex(where: { $0.id == candidate.id }),
              idx + 1 < userMsgs.count else { return nil }
        return userMsgs[idx + 1]
    }

    /// Sticky pill opacity. Two gates combined via `min`:
    ///
    ///   1. **Activation ramp** — fades in as the candidate bubble
    ///      drifts above the viewport top, reaching full opacity at
    ///      `stickyActivationOffset` above. While the bubble is still
    ///      partially in view (between top-of-viewport and the
    ///      activation offset), the in-chat bubble itself is doing
    ///      the visual work and the pill stays mostly transparent.
    ///   2. **Next-bubble fade-out** — when a newer user bubble
    ///      approaches the viewport top, the pill fades back to 0
    ///      to avoid double-rendering the active anchor.
    private var stickyOpacity: Double {
        guard let candidate = stickyCandidate,
              let candidateFrame = userBubbleFrames[candidate.id] else { return 0 }
        let aboveAmount = scrollOffsetY - candidateFrame.minY
        if aboveAmount <= 0 { return 0 }
        let activationProgress = min(aboveAmount / Self.stickyActivationOffset, 1)

        // Suppress when the agent reply for this turn hasn't crossed
        // into the pill's footprint yet. The reply starts at the
        // candidate's bottom edge in content space; in screen-Y that
        // is `candidateFrame.maxY - scrollOffsetY`. If that point sits
        // at or below the pill's bottom, the user is still scrolled
        // inside the candidate's own body and the in-chat bubble is
        // already doing the visual work — floating would just hover
        // over the same content (or empty space below it).
        let pillRenderedHeight = min(
            candidateFrame.height,
            StickyUserBubble.maxCollapsedHeight + StickyUserBubble.verticalPadding
        )
        let agentTopScreenY = candidateFrame.maxY - scrollOffsetY
        if agentTopScreenY >= pillRenderedHeight {
            return 0
        }

        // Suppress the pill when the agent reply for this turn is
        // fully visible. The reply spans from the candidate's bottom
        // edge to either the next user bubble's top (non-latest turn)
        // or the end of chat content (latest turn). If that end is
        // at or above the viewport bottom, the user can already see
        // the entire reply in context — floating the bubble adds
        // no anchoring value.
        //
        // For the "latest turn" case, use `effectiveContentBottom`
        // not `chatContentHeight`: the latter includes phantom
        // scrollable space behind the `.safeAreaInset(.bottom)`
        // input bar that the viewport can never reach, so a raw
        // comparison would never satisfy the suppression at any
        // scroll position.
        let viewportBottom = scrollOffsetY + viewportHeight
        let replyEndY: CGFloat
        if let next = nextUserBubbleAfterCandidate,
           let nextFrame = userBubbleFrames[next.id] {
            replyEndY = nextFrame.minY
        } else {
            replyEndY = effectiveContentBottom
        }
        if replyEndY > 0, replyEndY <= viewportBottom {
            return 0
        }

        guard let next = nextUserBubbleAfterCandidate,
              let nextFrame = userBubbleFrames[next.id] else {
            return Double(activationProgress)
        }
        // Visual gap from the pill's bottom edge to the next user
        // bubble's top. The pill renders the candidate's own content,
        // so its rendered height ≈ candidateFrame.height — using that
        // avoids a fragile preference-key round-trip for the actual
        // overlay height which was prone to staying at 0 in some
        // remount paths.
        let distance = nextFrame.minY - (scrollOffsetY + candidateFrame.height)
        let fadeOutProgress: CGFloat
        if distance >= Self.stickyFadeEnd {
            fadeOutProgress = 1
        } else if distance <= Self.stickyFadeStart {
            fadeOutProgress = 0
        } else {
            let span = Self.stickyFadeEnd - Self.stickyFadeStart
            fadeOutProgress = (distance - Self.stickyFadeStart) / span
        }
        return Double(max(0, min(activationProgress, fadeOutProgress)))
    }

    @ViewBuilder
    private func stickyUserOverlay(proxy: ScrollViewProxy) -> some View {
        // Always render the pill so its layout is stable across scroll
        // and candidate changes — only `opacity` and hit-testing flip
        // based on `stickyOpacity`. When there's no candidate, we fall
        // back to the latest user message so the view is laid out at a
        // real size while invisible; this avoids the brief width
        // measurement flicker that occurs when the pill is inserted /
        // removed from the tree on every viewport-top crossing.
        if let msg = stickyCandidate ?? lastUserMessage {
            StickyUserBubble(message: msg, expanded: $stickyExpanded)
                .padding(.top, Self.stickyMargin)
                .opacity(stickyOpacity)
                // Animate only when the pill flips between visible and
                // hidden (the boundary snap when a candidate crosses
                // the viewport top). The continuous 80→160 ramp keeps
                // tracking scroll directly with no animation interference.
                .animation(.easeInOut(duration: 0.18), value: stickyOpacity > 0)
                .contentShape(Rectangle())
                .onTapGesture {
                    guard stickyOpacity > 0,
                          let frame = userBubbleFrames[msg.id] else { return }
                    // Land msg.top 1pt above the viewport top — robust
                    // trigger for the natural rule's `aboveAmount <= 0`
                    // branch regardless of scroll precision. With
                    // stickyMargin = 0 the pill and bubble share the
                    // same screen y, so this 1pt is purely a rule-
                    // satisfying nudge, not a visual offset.
                    withAnimation(.easeInOut(duration: 0.25)) {
                        chatScrollPosition.scrollTo(y: frame.minY - 1)
                    }
                }
                .allowsHitTesting(stickyOpacity > 0.5)
                .onChange(of: msg.id) { _, _ in
                    // New candidate → collapse expansion so the pill
                    // doesn't carry over an unexpected expanded state.
                    stickyExpanded = false
                }
        }
    }

    // MARK: - Row Builders

    /// Standalone row. User-side messages publish their frame and a stable
    /// scroll-target id so the scroll helpers can locate them.
    @ViewBuilder
    private func standaloneRow(_ msg: ChatMessage) -> some View {
        let bubble = MessageBubbleView(
            message: msg,
            agent: session?.agent ?? "",
            historyExpanded: .constant(false)
        )

        if msg.type == "user_message" || msg.type == "send_input" {
            bubble
                .id(userScrollId(msg))
                .opacity(msg.id == stickyCandidate?.id ? (1 - stickyOpacity) : 1)
                .animation(.easeInOut(duration: 0.18), value: stickyOpacity > 0)
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: UserBubbleFramesKey.self,
                            value: [msg.id: geo.frame(in: .named("chat"))]
                        )
                    }
                )
        } else {
            // Tag non-user standalone rows (questions, answers,
            // session_created, etc.) with a generic scroll id so the
            // entry-scroll priority chain can target a pending
            // question card directly.
            bubble.id(messageScrollId(msg))
        }
    }

    /// Stable ScrollView target id for a user message bubble.
    private func userScrollId(_ msg: ChatMessage) -> String {
        "user-\(msg.id)"
    }

    /// Resolve the appropriate scroll id for any ChatMessage based on
    /// its type — user/send_input get `userScrollId`, everything else
    /// gets `messageScrollId`. Used by the entry-scroll priority
    /// chain so target messages map to their actual SwiftUI id.
    private func scrollId(for msg: ChatMessage) -> String {
        if msg.type == "user_message" || msg.type == "send_input" {
            return userScrollId(msg)
        }
        return messageScrollId(msg)
    }

    /// Position the rendered window so the target message is visible.
    /// Places the target's turn near the top of the window with up to
    /// 2 turns of context above (so backward scroll has something to
    /// reveal). Window grows downward up to `maxRenderedTurns`.
    private func ensureRenderedWindowIncludes(_ msg: ChatMessage) {
        let all = cachedRawTurns
        var idx = -1
        for (i, item) in all.enumerated() {
            switch item {
            case .standalone(let m):
                if m.id == msg.id { idx = i }
            case .turn(let t):
                if t.userMessage?.id == msg.id ||
                   t.finalMessage?.id == msg.id ||
                   t.thinkingMessages.contains(where: { $0.id == msg.id }) {
                    idx = i
                }
            }
            if idx >= 0 { break }
        }
        guard idx >= 0 else {
            KLog.d("🪟ensureRenderedWindowIncludes: msg=\(msg.id.prefix(8)) NOT FOUND in allTurns(\(all.count))")
            return
        }
        let beforeStart = renderWindowStartIdx
        let beforeCount = renderedTurnCount
        let bufferAbove = min(idx, 2)
        // Position so target is near the top with bufferAbove context.
        // End extends downward to fill the cap.
        let desiredStart = max(0, idx - bufferAbove)
        let desiredEnd = min(cachedAllTurnCount, desiredStart + Self.maxRenderedTurns)
        let (newStart, newEnd) = snapWindow(desiredStart: desiredStart, desiredEnd: desiredEnd)
        renderWindowStartIdx = newStart
        renderedTurnCount = max(1, newEnd - newStart)
        KLog.d("🪟ensureRenderedWindowIncludes: msg=\(msg.id.prefix(8)) at idx=\(idx)/\(cachedAllTurnCount); window startIdx=\(beforeStart)→\(renderWindowStartIdx) size=\(beforeCount)→\(renderedTurnCount) bufferAbove=\(bufferAbove)")
    }

    /// Stable ScrollView target id for any non-user message bubble
    /// (used by the entry-scroll priority chain to anchor on a
    /// pending question or the most-recent finalMessage).
    private func messageScrollId(_ msg: ChatMessage) -> String {
        "msg-\(msg.id)"
    }

    // MARK: - R3: Entry Positioning
    //
    // On first non-empty render of a session:
    //   - if read       → scroll to bottom (common case, no thrash)
    //   - if unread     → use the priority chain to anchor on the
    //                     most-useful spot for the user to start reading:
    //                       1. last unanswered question  → that card at top
    //                       2. if idle: last user_message / send_input → top
    //                       3. last turn with a finalMessage → top
    //                       4. fallback → bottom
    //
    // Race note: SessionDetailView.onAppear calls markRead which clears
    // unreadCounts. SessionDetailView dispatches markRead inside a
    // `Task { @MainActor in ... }` so this .task captures the unread
    // value first. The capture itself is synchronous at the top of this
    // function before any awaits.

    /// Resolve the entry-scroll target for an unread session. Returns
    /// `nil` to mean "scroll to bottom" (read sessions, or no usable
    /// unread anchor). Returns a target ChatMessage so callers can
    /// both derive the scroll id and ensure the rendered window
    /// includes it.
    ///
    /// Unread sessions anchor on the FIRST USER MESSAGE the user
    /// hasn't read yet — pinned to the viewport top. This way the
    /// user's own message sits at the top of the screen and the
    /// agent's reply appears naturally below, matching the
    /// read-from-the-question-down flow they expect.
    private func entryScrollTarget() -> (msg: ChatMessage, anchor: UnitPoint)? {
        let readSeq = sessionStore.sessions[sessionId]?.readSeq ?? 0
        // First user-side message with seq > readSeq, in chronological order.
        for msg in filteredMessages {
            guard msg.seq > readSeq else { continue }
            if msg.type == "user_message"
                || msg.type == "send_input"
                || msg.type == "pending_input" {
                KLog.d("entryScrollTarget=\(msg.id.prefix(8)) type=\(msg.type) seq=\(msg.seq) anchor=top (first unread user message)")
                return (msg, .top)
            }
        }

        // Fallback: bottom (no unread user message to anchor on).
        KLog.d("entryScrollTarget=nil → fallback to chat-bottom")
        return nil
    }

    private func performEntryScroll(proxy: ScrollViewProxy) async {
        // Populate the grouping cache before anything else reads it.
        // The cache backs `allGroupedTurns`, which dozens of helpers
        // below touch. Without this initial population, the first
        // body render would see `cachedRawTurns = []` and render an
        // empty chat for one frame, plus all helpers downstream would
        // see allTurns=0 and mis-size the window.
        refreshGroupingCache()
        KLog.d("📍entryScroll START sessionId=\(sessionId.prefix(8)) filteredMsgs=\(filteredMessages.count) allTurns=\(cachedAllTurnCount)")
        // Reset on session switch (.task(id:) re-runs when sessionId changes)
        didInitialScroll = false
        // NOTE: don't wipe userBubbleFrames here. By the time this async
        // task runs, the first layout pass may have already populated
        // frames via preference, and `geo.frame(in: .named("chat"))` is
        // a content-space value that doesn't re-emit on scroll — wiping
        // would leave us empty until the next layout-changing event.
        // On a fresh mount, @State defaults to [:] anyway. On a
        // session-id swap within the same mount, the next preference
        // fire will overwrite with new-session frames.
        scrollMetrics = ChatScrollMetrics(offsetY: 0, viewportHeight: scrollMetrics.viewportHeight, insetTop: scrollMetrics.insetTop, insetBottom: scrollMetrics.insetBottom, contentHeight: scrollMetrics.contentHeight)
        growMode = .idle
        lockedMsgId = nil
        // Reset the render window for the new session — last 5 turns
        // anchored to the bottom; the user can scroll up past the
        // spinner to expand the window, which grows up to
        // `maxRenderedTurns` then slides further as needed.
        let totalTurns = cachedAllTurnCount
        // Entry: anchor end at total, derive start with initial count.
        // snapWindow ensures start = user-message, end = right after turn.
        let initialEnd = totalTurns
        let initialStart = max(0, initialEnd - Self.initialRenderTurnCount)
        let (entryStart, entryEnd) = snapWindow(desiredStart: initialStart, desiredEnd: initialEnd)
        renderWindowStartIdx = entryStart
        renderedTurnCount = max(1, entryEnd - entryStart)
        lastWindowExpansion = nil
        pendingAnchorRestore = nil
        // Reset prepend-follow baseline. The initial refreshGroupingCache
        // above set lastKnownFirstTurnId to the new session's first
        // turn; clearing here ensures the very next refresh — which
        // may be the entry-poll picking up persisted messages — won't
        // see a stale value carried over from the previous session.
        lastKnownFirstTurnId = cachedRawTurns.first?.id
        // Capture whether we started empty BEFORE any await. We use
        // this at the tail to distinguish "fresh load — all messages
        // are backfill, baseline silently" from "session was already
        // populated — any seq increase during entry is a NEW user
        // message that needs retroactive R1 activation".
        let startedEmpty = filteredMessages.isEmpty
        // Baseline R1 trigger to the current last user-message seq so
        // that the act of opening a session (which exposes existing
        // messages) does not look like a "user just sent a new message".
        lockedUserSeq = lastUserMessage?.seq ?? 0

        // Snapshot unread BEFORE any await so SessionDetailView's deferred
        // markRead can't race ahead of us. Prefer SessionDetailView's
        // synchronous capture (entryUnreadSnapshots) over the live count,
        // since markRead's MainActor Task is scheduled FIFO ahead of this
        // .task body and would otherwise have already cleared the count.
        let wasUnread: Bool = {
            if let snap = sessionStore.entryUnreadSnapshots[sessionId] {
                sessionStore.entryUnreadSnapshots.removeValue(forKey: sessionId)
                return snap
            }
            // Derive from seq pipeline (replaces the old unreadCounts dict).
            guard let s = sessionStore.sessions[sessionId] else { return false }
            return s.lastSeq > s.readSeq
        }()
        KLog.d("📍entryScroll wasUnread=\(wasUnread) startedEmpty=\(startedEmpty) lockedUserSeq=\(lockedUserSeq) sessionIdle=\(sessionIdle)")

        // Wait for messages + initial layout. We poll briefly because the
        // first non-empty render may arrive after this task starts.
        var attempts = 0
        while filteredMessages.isEmpty && attempts < 20 {
            try? await Task.sleep(for: .milliseconds(25))
            attempts += 1
        }

        // One extra layout tick so LazyVStack has built the rows we want
        // to target.
        try? await Task.sleep(for: .milliseconds(30))

        guard !filteredMessages.isEmpty else {
            KLog.d("📍entryScroll → still empty after poll, bailing")
            didInitialScroll = true
            return
        }

        // Refresh the cache now that the polling window is done — new
        // messages may have arrived during the awaits, and we need
        // the post-poll turn count to size the window correctly.
        refreshGroupingCache()

        // Re-anchor the render window to the bottom now that we know
        // the real turn count. If `startedEmpty` was true at the top
        // this is the first time we have a valid total to position
        // the window against.
        let totalTurnsAfterPoll = cachedAllTurnCount
        let pollEnd = totalTurnsAfterPoll
        let pollStart = max(0, pollEnd - Self.initialRenderTurnCount)
        let (pollNewStart, pollNewEnd) = snapWindow(desiredStart: pollStart, desiredEnd: pollEnd)
        renderWindowStartIdx = pollNewStart
        renderedTurnCount = max(1, pollNewEnd - pollNewStart)
        // Initialize the follow-bottom baseline. Without this, the
        // first `followBottomOnNewTurns()` call would see
        // `lastSeenTotalTurns = 0` and treat the window as "at
        // bottom" unconditionally, dragging the user to the bottom
        // on first new message even mid-history-exploration.
        lastSeenTotalTurns = totalTurnsAfterPoll

        KLog.d("📍entryScroll poll done → filteredMsgs=\(filteredMessages.count) allTurns=\(totalTurnsAfterPoll) window=[\(renderWindowStartIdx),\(renderWindowStartIdx+renderedTurnCount)) viewportH=\(viewportHeight) contentH=\(chatContentHeight)")
        logWindowStateIfChanged(reason: "entry-scroll")
        logSpinnerStateIfChanged(reason: "entry-scroll")

        // Re-baseline ONLY for fresh loads — the messages that just
        // landed are historical backfill and must not trip R1. For
        // sessions that already had messages, leave the baseline at
        // its pre-await value so the tail-replay below can detect any
        // user message that arrived during entry and retroactively
        // activate R1.
        if startedEmpty {
            lockedUserSeq = lastUserMessage?.seq ?? 0
        }

        if wasUnread, let target = entryScrollTarget() {
            // Unread → land on a specific bubble at the target's
            // anchor and keep re-asserting until content stabilizes.
            // Without the loop, gap-bridge or auto-load prepends that
            // arrive after the initial scrollTo push the target's
            // content-space minY past where we anchored — leaving the
            // user on older content instead of their intended target.
            let beforeCount = renderedTurnCount
            ensureRenderedWindowIncludes(target.msg)
            if renderedTurnCount != beforeCount {
                KLog.d("📍entryScroll ensureRenderedWindowIncludes bumped \(beforeCount)→\(renderedTurnCount)")
            }
            let scrollTarget = (id: scrollId(for: target.msg), anchor: target.anchor)
            KLog.d("📍entryScroll unread branch → scrollTo id=\(scrollTarget.id) anchor=\(scrollTarget.anchor) targetFrame=\(userBubbleFrames[target.msg.id].map { "minY=\($0.minY) h=\($0.height)" } ?? "nil")")
            stickToTargetInstant(proxy: proxy, target: scrollTarget)
            await settleEntry { stickToTargetInstant(proxy: proxy, target: scrollTarget) }
            KLog.d("📍entryScroll unread settle done → offsetY=\(scrollOffsetY) viewportH=\(viewportHeight) contentH=\(chatContentHeight) targetFrame=\(userBubbleFrames[target.msg.id].map { "minY=\($0.minY) h=\($0.height)" } ?? "nil")")
        } else {
            // Read → land at the bottom and keep re-pinning. Content
            // height typically keeps growing for several hundred ms
            // after the first batch lands (MarkdownUI reflow,
            // AsyncImage attachments decoding, MessageBubbleView
            // post-layout sizing, late safe-area-inset measurement).
            // If we flip `didInitialScroll = true` right after a
            // single scrollTo, `currentScrollAnchor` switches to nil
            // and SwiftUI stops auto-pinning — leaving us frozen
            // above the eventual bottom by however much content grew.
            //
            // While the loop runs `currentScrollAnchor` is still
            // `.bottom`, so defaultScrollAnchor backs us up if a
            // proxy.scrollTo gets dropped. Animations disabled so
            // the repeated re-scrolls are silent corrections, not
            // visible bounces.
            KLog.d("📍entryScroll read branch → scrollTo chat-bottom")
            scrollToBottomInstant(proxy: proxy)
            await settleEntry { scrollToBottomInstant(proxy: proxy) }
            KLog.d("📍entryScroll read settle done → offsetY=\(scrollOffsetY) viewportH=\(viewportHeight) contentH=\(chatContentHeight)")
        }
        didInitialScroll = true

        // Tail step 1: if the session is already idle on entry, capture
        // the idle anchor now. `onChange(of: sessionIdle)` only fires
        // on transitions — without this, opening an already-idle
        // session never acquires the anchor and expand/collapse of
        // thinking history shifts the user bubble with no
        // compensation.
        if sessionIdle {
            acquireIdleAnchor()
        }

        // Tail step 2: retroactively activate R1 for any user message
        // that arrived during the entry-scroll window. We deliberately
        // skip the fresh-load path (`startedEmpty == true`) because in
        // that case the seq increase is from backfill, not a live send.
        if !startedEmpty,
           let last = lastUserMessage,
           last.seq > lockedUserSeq {
            handleNewUserMessage(proxy: proxy, seq: last.seq)
        }
    }

    /// Stick the chat to the given target for ~100ms of content
    /// stability (or 750ms hard cap), re-asserting the position each
    /// 25ms tick via the caller-supplied closure. Used by both the
    /// read (bottom) and unread (specific bubble) entry-scroll paths.
    private func settleEntry(reassert: () -> Void) async {
        var prevHeight = chatContentHeight
        var stableTicks = 0
        let stabilityTarget = 4   // ~100ms quiet
        let maxTicks = 30         // ~750ms cap
        var ticks = 0
        while ticks < maxTicks {
            try? await Task.sleep(for: .milliseconds(25))
            reassert()
            if abs(chatContentHeight - prevHeight) < 0.5 {
                stableTicks += 1
                if stableTicks >= stabilityTarget { break }
            } else {
                stableTicks = 0
                prevHeight = chatContentHeight
            }
            ticks += 1
        }
    }

    /// Animation-free scroll to a specific entry target. Mirror of
    /// `scrollToBottomInstant` but for the unread entry path.
    private func stickToTargetInstant(proxy: ScrollViewProxy, target: (id: String, anchor: UnitPoint)) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            // Drive scroll through the binding — `.scrollPosition`
            // attached to the ScrollView takes precedence over
            // `proxy.scrollTo`, which is silently ignored. The proxy
            // call is kept as a belt-and-suspenders fallback.
            chatScrollPosition.scrollTo(id: target.id, anchor: target.anchor)
            proxy.scrollTo(target.id, anchor: target.anchor)
        }
    }

    // MARK: - R1: Growing-Reply

    /// Called when `lastUserMessage.seq` changes. We only enter R1 if the
    /// new seq is strictly greater than our baseline, which uniquely
    /// identifies a freshly-sent user message (vs. backfill or session
    /// switch, which don't increase past baseline).
    private func handleNewUserMessage(proxy: ScrollViewProxy, seq: Int) {
        guard didInitialScroll, seq > lockedUserSeq else { return }
        guard let msg = lastUserMessage else { return }
        lockedUserSeq = seq
        lockedMsgId = msg.id
        growMode = .followBottom
        // Snap the render window to the bottom — R1's anchor bubble
        // (the new user message) MUST be in the rendered tree for
        // `userBubbleFrames[msg.id]` to be populated and for
        // `checkLockTransition` to work. If the user was exploring
        // history when a live message arrived, this drags them to
        // the latest turn alongside R1's followBottom scroll.
        let total = cachedAllTurnCount
        if total > 0 {
            // End at total (latest), derive start.
            let newDesiredEnd = total
            let newDesiredStart = max(0, newDesiredEnd - Self.maxRenderedTurns)
            let (newWStart, newWEnd) = snapWindow(desiredStart: newDesiredStart, desiredEnd: newDesiredEnd)
            renderWindowStartIdx = newWStart
            renderedTurnCount = max(1, newWEnd - newWStart)
        }
        // Reset the visibility gate. LOCK in checkLockTransition is only
        // permitted after we've seen the new bubble inside the viewport
        // at least once — this prevents an immediate re-LOCK when a
        // previous .lockedAtTop session left scrollOffsetY high.
        //
        // Note: we deliberately do NOT wipe userBubbleFrames[msg.id]
        // here. The plain VStack lays out every row, but `geo.frame(in:
        // .named("chat"))` is a content-space value that only changes
        // when the row itself moves — agent-message growth below it
        // does not move it. SwiftUI dedupes onPreferenceChange on
        // equal dicts, so a wipe would never be replenished and the
        // sticky-pill candidate filter would lose this msg forever.
        // checkLockTransition's `frame.height > 0` guard already
        // protects against pre-layout samples.
        sawBubbleBelowTop = false
        scrollToBottomInstant(proxy: proxy)
    }

    private func checkLockTransition(proxy: ScrollViewProxy) {
        guard growMode == .followBottom else { return }

        scrollToBottomInstant(proxy: proxy)

        guard let mid = lockedMsgId,
              let frame = userBubbleFrames[mid] else {
            return
        }
        // Ignore pre-layout / uninitialized GeometryReader samples. A real
        // user bubble always has a positive height once SwiftUI has placed
        // it; before that, minY can be a small negative sentinel which
        // would falsely satisfy the "reached top" condition below.
        guard frame.height > 0 else {
            return
        }
        let topInViewport = frame.minY - scrollOffsetY
        // Visibility gate: don't allow LOCK until the bubble has actually
        // been seen inside the viewport. Without this, a stale scroll
        // position from a previous .lockedAtTop session can present a
        // negative topInViewport on the first tick, causing an immediate
        // re-LOCK before R1 ever runs.
        if topInViewport > 0 {
            sawBubbleBelowTop = true
        }
        guard sawBubbleBelowTop else { return }
        if topInViewport <= 0 {
            // The user bubble has reached the top line. Stop auto-
            // scrolling to the bottom and pin the bubble to the
            // viewport top as the in-chat visual anchor. We snap
            // with `proxy.scrollTo(anchor: .top)` to clean up any
            // overshoot from a chunky streaming tick (which can
            // land topInViewport at e.g. -40 in one frame).
            //
            // While locked here, `aboveAmount` (= scrollOffsetY -
            // bubble.minY) is held at 0, so `stickyOpacity` stays
            // at 0 — the floating pill does NOT take over during
            // streaming. The reply continues streaming into the
            // area below the visible viewport; the user can
            // manually scroll down to follow it, and only then
            // (once they actually scroll past the bubble) does
            // the pill fade in via the activation ramp.
            proxy.scrollTo(userScrollId(forMsgId: mid), anchor: .top)
            growMode = .lockedAtTop
        }
    }

    /// Scroll to the chat-bottom sentinel WITHOUT any spring animation.
    /// During R1 followBottom this needs to keep up with text streaming
    /// in real time; the default spring animation lags far behind the
    /// content growth and causes the user bubble + new reply to slide
    /// off the bottom of the viewport. Disabling the transaction's
    /// animation makes the scroll snap each tick so the bottom edge
    /// stays visually pinned.
    private func scrollToBottomInstant(proxy: ScrollViewProxy) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            // The `.scrollPosition($chatScrollPosition, anchor: .top)`
            // modifier on the ScrollView takes precedence over
            // `proxy.scrollTo` calls — proxy.scrollTo is silently
            // ignored when the binding is attached. Drive scroll
            // through the binding instead. Confirmed working via the
            // bottom-edge SNAP rule which uses the same mechanism.
            chatScrollPosition.scrollTo(id: "chat-bottom", anchor: .bottom)
            // Keep the proxy.scrollTo as a belt-and-suspenders for any
            // SwiftUI version where the binding-driven scroll doesn't
            // resolve to the chat-bottom row id.
            proxy.scrollTo("chat-bottom", anchor: .bottom)
        }
    }

    /// Scroll-target id for a known ChatMessage.id (mirror of
    /// `userScrollId(_:)` for callers that only have the id).
    private func userScrollId(forMsgId mid: String) -> String {
        "user-\(mid)"
    }

    /// id of the topmost user bubble whose top edge is INSIDE the
    /// current viewport (between viewport top and viewport bottom).
    /// Used by `handleTopEdgeExpand` to anchor scroll position so that
    /// prepending older turns doesn't visually jump the user.
    ///
    /// Important: the filter requires the bubble to actually be in
    /// the viewport, not just below scrollOffsetY. Otherwise, in a
    /// long agent message with no user bubbles in view, the picker
    /// would return a bubble far below the viewport, and the
    /// restoration math would yank the scroll to a position
    /// unrelated to what the user is looking at.
    ///
    /// Returns nil if no user bubble is in the viewport (e.g.,
    /// inside a long agent reply). Caller falls back to SwiftUI's
    /// default anchor behavior.
    private func topmostVisibleUserBubbleId() -> String? {
        let viewportTop = scrollOffsetY
        let viewportBottom = scrollOffsetY + viewportHeight
        let candidates = userBubbleFrames.filter { (_, frame) in
            frame.height > 0
                && frame.minY >= viewportTop
                && frame.minY < viewportBottom
        }.sorted { $0.value.minY < $1.value.minY }
        return candidates.first?.key
    }

    /// Picks the bottommost user bubble currently in viewport.
    /// Mirror of `topmostVisibleUserBubbleId()` for the bottom edge.
    /// Used by `handleBottomEdgeExpand` so that when the window
    /// slides down (top drops, bottom adds), the captured anchor is
    /// near the END of the window and is guaranteed to survive the
    /// slide — bubbles dropped from the rendered tree come from the
    /// TOP of the window.
    private func bottommostVisibleUserBubbleId() -> String? {
        let viewportTop = scrollOffsetY
        let viewportBottom = scrollOffsetY + viewportHeight
        let candidates = userBubbleFrames.filter { (_, frame) in
            frame.height > 0
                && frame.minY >= viewportTop
                && frame.minY < viewportBottom
        }.sorted { $0.value.minY > $1.value.minY }
        return candidates.first?.key
    }

    // MARK: - Idle anchor lock

    /// Capture the latest user bubble's current screen Y so subsequent
    /// layout changes can compensate scroll and leave it visually fixed.
    /// Called when the session goes idle (turn complete).
    private func acquireIdleAnchor() {
        guard let last = lastUserMessage,
              let frame = userBubbleFrames[last.id],
              frame.height > 0 else {
            return
        }
        anchoredUserMsgId = last.id
        anchoredScreenY = frame.minY - scrollOffsetY
    }

    /// Drop the idle anchor. Called on user-initiated scroll, on a
    /// new user message (R1 takes over), and on session switch.
    private func releaseIdleAnchor() {
        anchoredUserMsgId = nil
        anchoredScreenY = nil
    }

    /// If the idle anchor is active and the anchored bubble has
    /// moved (content above the bubble grew/shrank, or content
    /// below pushed it indirectly), compensate scroll so its
    /// screen Y matches the captured anchor. No-op while R1 is
    /// driving scroll.
    private func enforceIdleAnchor() {
        guard growMode == .idle,
              let mid = anchoredUserMsgId,
              let targetScreenY = anchoredScreenY,
              let frame = userBubbleFrames[mid],
              frame.height > 0,
              viewportHeight > 0 else {
            return
        }
        let currentScreenY = frame.minY - scrollOffsetY
        // Sub-pixel jitter shouldn't trigger a correction; only act
        // on meaningful drift (>= 0.5pt). Without this guard, the
        // chained scroll → preference → enforce loop can endlessly
        // self-trigger by half-pixel rounding.
        guard abs(currentScreenY - targetScreenY) >= 0.5 else { return }
        let newContentOffsetY = (frame.minY - targetScreenY) - chatScrollInsetTop
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            chatScrollPosition.scrollTo(y: newContentOffsetY)
        }
    }

    // MARK: - Bottom Input Area

    @ViewBuilder
    private var bottomInputArea: some View {
        MessageInputView(
            sessionId: sessionId,
            pendingPermission: permissions.first,
            pendingQuestion: permissions.isEmpty ? questions.first : nil
        )
    }

    // MARK: - Helpers

    /// Collect image attachments from tool_complete messages in a turn's thinking.
    private func collectTurnImages(_ thinkingMessages: [ChatMessage]) -> [ImageAttachment] {
        var images: [ImageAttachment] = []
        for m in thinkingMessages {
            guard m.type == "tool_complete", let attachments = m.attachments else { continue }
            for att in attachments {
                if att.type == "image" {
                    images.append(att)
                }
            }
        }
        return images
    }
}

// MARK: - Sticky User Bubble

/// Floating "glass" copy of a user message used by R2 to pin the most
/// recent user turn at the top of the viewport when it scrolls above
/// the fold. Layout intentionally mirrors `MessageBubbleView.userBubble`
/// (same Spacer minLength, padding, font, and shape) so the bubble does
/// NOT visually resize during the in-chat → floating handoff. Background
/// is swapped for liquid glass with a faint accent tint so chat content
/// stays readable through the chip.
private struct StickyUserBubble: View {
    let message: ChatMessage
    @Binding var expanded: Bool

    /// Max bubble content height before the expand affordance shows up.
    /// 9% of screen — keeps the pinned bubble compact at the top.
    fileprivate static var maxCollapsedHeight: CGFloat {
        UIScreen.main.bounds.height * 0.09
    }

    /// Total vertical padding wrapping the pill content (10pt top + 10pt
    /// bottom — see `.padding(.vertical, 10)` in `body`). Exposed so the
    /// containing view can reason about the pill's full rendered height.
    fileprivate static let verticalPadding: CGFloat = 20

    @State private var naturalHeight: CGFloat = 0

    private var content: String? {
        if message.type == "send_input" {
            return message.payload["text"]?.stringValue
        }
        return message.content
    }

    private var needsExpand: Bool {
        naturalHeight > Self.maxCollapsedHeight + 2
    }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: UIScreen.main.bounds.width * 0.10)
            textBlock
                .overlay(alignment: .bottom) {
                    if needsExpand {
                        expandButton
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .modifier(StickyGlassPillModifier(tint: Color.accentColor))
                .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
        .padding(.horizontal, 12)
        .onPreferenceChange(StickyContentHeightKey.self) { h in
            naturalHeight = h
        }
        .animation(.easeInOut(duration: 0.22), value: expanded)
    }

    @ViewBuilder
    private var textBlock: some View {
        let limit: CGFloat? = (needsExpand && !expanded) ? Self.maxCollapsedHeight : nil
        textView
            .background(
                // Hidden ghost copy at natural size to measure the
                // intrinsic content height, regardless of the visible
                // copy's `.frame(maxHeight:)` clamp.
                textView
                    .opacity(0)
                    .accessibilityHidden(true)
                    .allowsHitTesting(false)
                    .background(
                        GeometryReader { geo in
                            Color.clear.preference(
                                key: StickyContentHeightKey.self,
                                value: geo.size.height
                            )
                        }
                    )
            )
            .frame(maxHeight: limit, alignment: .top)
            .clipped()
            .mask(
                // When collapsed, fade the bottom of the text to fully
                // transparent so it visually trails off into the chevron
                // area instead of getting clipped mid-line.
                LinearGradient(
                    stops: (needsExpand && !expanded)
                        ? [
                            .init(color: .black, location: 0),
                            .init(color: .black, location: 0.8),
                            .init(color: .black.opacity(0), location: 1.0)
                        ]
                        : [.init(color: .black, location: 0), .init(color: .black, location: 1)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
    }

    @ViewBuilder
    private var textView: some View {
        if let text = content, !text.isEmpty, text != "[image]" {
            Text(markdown(text))
                .font(.subheadline)
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
        } else {
            Text("Photo")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.85))
        }
    }

    private var expandButton: some View {
        Button {
            expanded.toggle()
        } label: {
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white.opacity(0.9))
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .bottom)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.bottom, -6)
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(text)
    }
}

private struct StickyContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Liquid-glass pill backing for the R2 sticky user bubble. Uses the
/// same `UnevenRoundedRectangle` shape as the regular user bubble so
/// the float-in keeps the same silhouette. Tints the regular glass
/// material with a low-opacity accent on iOS 26+, falls back to a
/// semi-translucent accent fill on older iOS.
private struct StickyGlassPillModifier: ViewModifier {
    let tint: Color

    private var shape: some Shape {
        UnevenRoundedRectangle(
            topLeadingRadius: 16,
            bottomLeadingRadius: 16,
            bottomTrailingRadius: 16,
            topTrailingRadius: 4
        )
    }

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular.tint(tint.opacity(0.25)), in: shape)
        } else {
            content
                .background(tint.opacity(0.6), in: shape)
        }
    }
}

#endif
