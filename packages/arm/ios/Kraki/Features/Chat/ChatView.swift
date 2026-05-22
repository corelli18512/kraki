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
    private static let initialRenderTurnCount: Int = 5
    /// Number of additional turns to bring into the rendered window
    /// each time the user hits the spinner threshold and folded
    /// in-memory turns remain.
    private static let renderExpandStep: Int = 5
    /// Hard cap on the rendered window size. Once the window has
    /// grown to this size, further top-edge expansion drops an equal
    /// number of turns from the bottom (sliding window). Conversely
    /// when the user scrolls toward the bottom-edge of the rendered
    /// window with folded turns below, the window slides down. Keeps
    /// layout passes bounded regardless of how much history the user
    /// scrolls through.
    private static let maxRenderedTurns: Int = 15
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
        offsetY: 0, viewportHeight: 0, insetTop: 0, contentHeight: 0
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
    /// Total chat scroll content height (in content space). Used to
    /// detect "the agent reply for this turn is fully visible" for
    /// the latest user message — when content's bottom edge is at or
    /// above the viewport bottom, the pill is suppressed.
    private var chatContentHeight: CGFloat { scrollMetrics.contentHeight }

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

    /// Whether to show the top spinner row. Only true during an
    /// actual network fetch — window expansion (priority 1 of
    /// `maybeAutoLoadOlder`) is synchronous and doesn't warrant a
    /// spinner. Once the fetch completes `isLoading` flips false
    /// and the spinner disappears.
    private var showTopSpinner: Bool {
        // Need both: there's actually more network history to load
        // (otherwise spinner is misleading) AND we're currently
        // fetching. Without the first guard we'd briefly flash the
        // spinner if `isLoading` is true for some unrelated reason.
        let seqs = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }
        guard let first = seqs.min(), first > 1 else { return false }
        return isLoading
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
        return raw + [.turn(Turn(id: "streaming", thinkingMessages: [], finalMessage: nil, isActive: true))]
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
            result.append(.turn(Turn(id: "streaming", thinkingMessages: [], finalMessage: nil, isActive: true)))
        }
        return result
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
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            // Hide the entire compose area while the relay
                            // channel is broken — the user can't send anything
                            // anyway and the chat surface is read-only.
                            if isDeviceOnline && appState.isFullyOnline {
                                bottomInputArea
                            }
                        }
                }
            }
            .background(Color.surfacePrimary)
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
                // Top spinner row — visible only while a NETWORK fetch
                // is in flight. Window expansion (priority 1 of
                // `maybeAutoLoadOlder`) is synchronous and needs no
                // spinner. Threshold detection lives in
                // `maybeAutoLoadOlder` via scrollOffsetY, so the
                // spinner's presence is not needed for the trigger.
                if showTopSpinner {
                    HStack {
                        Spacer()
                        ProgressView()
                            .controlSize(.small)
                            .tint(.krakiPrimary)
                        Spacer()
                    }
                    .frame(height: Self.topSpinnerHeight)
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
                contentHeight: geo.contentSize.height
            )
        } action: { _, m in
            // Single observable mutation per scroll event. Helpers
            // that themselves mutate scroll position (checkLockTransition's
            // proxy.scrollTo, maybeAutoLoadOlder's renderedTurnCount bump)
            // are deferred to the next runloop turn so they don't
            // re-fire this action inside the same render pass — which is
            // what produced the "tried to update multiple times per frame"
            // runtime warning.
            scrollMetrics = m
            Task { @MainActor in
                checkLockTransition(proxy: proxy)
                maybeAutoLoadOlder()
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
        }
        .onPreferenceChange(UserBubbleFramesKey.self) { newFrames in
            // Plain VStack lays out every row eagerly, so `newFrames`
            // always contains a fresh frame for every user bubble.
            // Replace (don't merge) — merging causes stale-low minY
            // values to linger after older messages are prepended,
            // which then wrongly satisfy `f.minY <= scrollOffsetY`
            // and surface a sticky candidate that shouldn't exist.
            userBubbleFrames = newFrames
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
            // Recompute the (expensive) raw turn grouping ONCE per
            // batch instead of on every body re-render. All
            // downstream rules (followBottom, autoLoad, edge slides,
            // R3 target window-include) read from the cache.
            refreshGroupingCache()
            // After each batch lands, if the top spinner is still
            // visible and older history still exists, kick off the
            // next page so we keep loading until either the spinner
            // scrolls out of view or we hit firstSeq=1.
            maybeAutoLoadOlder()
            // If new turns appeared at the BOTTOM AND the rendered
            // window was previously anchored to the bottom (i.e., the
            // user wasn't exploring history), slide the window down
            // to keep the latest turns visible. Without this rule,
            // new messages arriving while the user is on the chat
            // screen end up folded below the rendered window and
            // become invisible — symptom: R2 pill shows an OLD user
            // message because the actual latest user message isn't
            // even rendered.
            followBottomOnNewTurns()
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
    private func maybeAutoLoadOlder() {
        // Don't auto-load until entry-scroll has positioned us.
        guard didInitialScroll else { return }
        // Don't slide while R1 owns scroll — its anchor bubble must
        // stay in the rendered window.
        guard growMode == .idle else { return }

        // Top-edge: expand window upward
        let topThreshold = Self.topSpinnerHeight + Self.topSpinnerSlop
        if scrollOffsetY < topThreshold {
            handleTopEdgeExpand()
            return
        }

        // Bottom-edge: slide window downward (only when there's
        // somewhere below to slide into)
        let viewportBottomY = scrollOffsetY + viewportHeight
        let bottomThreshold = chatContentHeight - Self.bottomEdgeSlop
        if hasFoldedTurnsBelow && viewportBottomY > bottomThreshold {
            handleBottomEdgeExpand()
            return
        }
    }

    /// Top-edge expansion: grow window upward, or slide up if at cap.
    private func handleTopEdgeExpand() {
        // Priority 1: bring folded-above turns into the window.
        if hasFoldedTurnsAbove {
            let now = Date()
            if let last = lastWindowExpansion,
               now.timeIntervalSince(last) < Self.windowExpandDebounce {
                return
            }
            lastWindowExpansion = now

            let total = cachedAllTurnCount
            let beforeStart = renderWindowStartIdx
            let beforeCount = renderedTurnCount
            let newStart = max(0, renderWindowStartIdx - Self.renderExpandStep)
            if renderedTurnCount < Self.maxRenderedTurns {
                // Grow: extend top, keep bottom edge fixed.
                renderedTurnCount = min(Self.maxRenderedTurns,
                                         renderedTurnCount + Self.renderExpandStep)
            }
            // After potential growth, clamp so window stays in bounds.
            renderWindowStartIdx = min(newStart, max(0, total - renderedTurnCount))
            KLog.d("🔝autoLoad top-edge expand startIdx=\(beforeStart)→\(renderWindowStartIdx) size=\(beforeCount)→\(renderedTurnCount) (allTurns=\(total))")
            return
        }

        // Priority 2: network fetch for older history not yet in memory.
        guard !isLoading else { return }
        let firstSeq = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }.min() ?? Int.max
        guard firstSeq > 1 else {
            KLog.d("🔝autoLoad: skip network (firstSeq=\(firstSeq) — already at session start)")
            return
        }
        KLog.d("🔝autoLoad: network-fetch beforeSeq=\(firstSeq) offsetY=\(scrollOffsetY)")
        appState.messageProvider?.requestBefore(sessionId: sessionId, beforeSeq: firstSeq)
    }

    /// Bottom-edge expansion: slide window down to bring folded-below
    /// turns into view. Drops an equivalent number of turns from the
    /// top (the user is approaching the bottom; top turns are well
    /// off-screen).
    private func handleBottomEdgeExpand() {
        let now = Date()
        if let last = lastWindowExpansion,
           now.timeIntervalSince(last) < Self.windowExpandDebounce {
            return
        }
        lastWindowExpansion = now

        let total = cachedAllTurnCount
        let beforeStart = renderWindowStartIdx
        let newStart = min(total - renderedTurnCount,
                            renderWindowStartIdx + Self.renderExpandStep)
        renderWindowStartIdx = max(0, newStart)
        KLog.d("🔻autoLoad bottom-edge slide startIdx=\(beforeStart)→\(renderWindowStartIdx) size=\(renderedTurnCount) (allTurns=\(total))")
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
            renderedTurnCount = min(Self.maxRenderedTurns, newTotal)
        } else {
            renderWindowStartIdx = max(0, newTotal - renderedTurnCount)
        }
        if renderWindowStartIdx != beforeStart || renderedTurnCount != beforeCount {
            KLog.d("📌followBottom slide startIdx=\(beforeStart)→\(renderWindowStartIdx) size=\(beforeCount)→\(renderedTurnCount) (total \(lastSeenTotalTurns)→\(newTotal))")
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

        // Suppress the pill when the agent reply for this turn is
        // fully visible. The reply spans from the candidate's bottom
        // edge to either the next user bubble's top (non-latest turn)
        // or the end of chat content (latest turn). If that end is
        // at or above the viewport bottom, the user can already see
        // the entire reply in context — floating the bubble adds
        // no anchoring value.
        let viewportBottom = scrollOffsetY + viewportHeight
        let replyEndY: CGFloat
        if let next = nextUserBubbleAfterCandidate,
           let nextFrame = userBubbleFrames[next.id] {
            replyEndY = nextFrame.minY
        } else {
            replyEndY = chatContentHeight
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
                if t.finalMessage?.id == msg.id ||
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
        renderWindowStartIdx = idx - bufferAbove
        renderedTurnCount = min(Self.maxRenderedTurns, cachedAllTurnCount - renderWindowStartIdx)
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
    /// `nil` to mean "scroll to bottom" (rules 4 or no usable target).
    /// Returns the target ChatMessage so callers can both derive the
    /// scroll id and ensure the rendered window includes it.
    private func entryScrollTarget() -> (msg: ChatMessage, anchor: UnitPoint)? {
        // 1. Last unanswered question — but ONLY if it's still
        //    "pending": no user message has been sent after it. A
        //    question with no answer + no resolution + a later user
        //    message has been superseded (user typed a follow-up
        //    instead of answering). Without this guard, the rule
        //    pulls users back into ancient history every time they
        //    re-open a session that ever contained an unanswered
        //    question.
        let lastUserSeq = lastUserMessage?.seq ?? -1
        for msg in filteredMessages.reversed() {
            if msg.type == "question" {
                let answer = msg.answer ?? ""
                let resolution = msg.resolution
                if answer.isEmpty && resolution == nil && msg.seq > lastUserSeq {
                    KLog.d("entryScrollTarget=\(msg.id.prefix(8)) type=question seq=\(msg.seq) anchor=top (priority 1: pending unanswered question)")
                    return (msg, .top)
                }
            }
        }

        // 2. If idle, last user_message / send_input — read your own
        //    message → agent's reply naturally.
        if sessionIdle, let target = lastUserMessage {
            KLog.d("entryScrollTarget=\(target.id.prefix(8)) type=\(target.type) seq=\(target.seq) anchor=top (priority 2: idle+lastUser)")
            return (target, .top)
        }

        // 3. Last turn with a finalMessage — read the latest agent reply
        //    from the start.
        for msg in filteredMessages.reversed() {
            if msg.type == "agent_message" {
                // Only treat as a turn-final if it's the last
                // agent_message and followed only by idle/standalone
                // boundary types. Defensive — most "agent_message"
                // entries in an idle session ARE finals.
                KLog.d("entryScrollTarget=\(msg.id.prefix(8)) type=agent_message seq=\(msg.seq) anchor=top (priority 3: lastAgentMessage)")
                return (msg, .top)
            }
        }

        // 4. Fallback: bottom.
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
        scrollMetrics = ChatScrollMetrics(offsetY: 0, viewportHeight: scrollMetrics.viewportHeight, insetTop: scrollMetrics.insetTop, contentHeight: scrollMetrics.contentHeight)
        growMode = .idle
        lockedMsgId = nil
        // Reset the render window for the new session — last 5 turns
        // anchored to the bottom; the user can scroll up past the
        // spinner to expand the window, which grows up to
        // `maxRenderedTurns` then slides further as needed.
        let totalTurns = cachedAllTurnCount
        renderedTurnCount = min(Self.initialRenderTurnCount, max(1, totalTurns))
        renderWindowStartIdx = max(0, totalTurns - renderedTurnCount)
        lastWindowExpansion = nil
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
        renderedTurnCount = min(Self.initialRenderTurnCount, max(1, totalTurnsAfterPoll))
        renderWindowStartIdx = max(0, totalTurnsAfterPoll - renderedTurnCount)
        // Initialize the follow-bottom baseline. Without this, the
        // first `followBottomOnNewTurns()` call would see
        // `lastSeenTotalTurns = 0` and treat the window as "at
        // bottom" unconditionally, dragging the user to the bottom
        // on first new message even mid-history-exploration.
        lastSeenTotalTurns = totalTurnsAfterPoll

        KLog.d("📍entryScroll poll done → filteredMsgs=\(filteredMessages.count) allTurns=\(totalTurnsAfterPoll) window=[\(renderWindowStartIdx),\(renderWindowStartIdx+renderedTurnCount)) viewportH=\(viewportHeight) contentH=\(chatContentHeight)")

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
            renderWindowStartIdx = max(0, total - renderedTurnCount)
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
            proxy.scrollTo("chat-bottom", anchor: .bottom)
        }
    }

    /// Scroll-target id for a known ChatMessage.id (mirror of
    /// `userScrollId(_:)` for callers that only have the id).
    private func userScrollId(forMsgId mid: String) -> String {
        "user-\(mid)"
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
    private static var maxCollapsedHeight: CGFloat {
        UIScreen.main.bounds.height * 0.09
    }

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
