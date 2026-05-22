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

/// PreferenceKey for the measured height of the R2 sticky overlay
/// (including its outer top margin). Used by stickyHandoffOffset so
/// the handoff band matches the actual rendered chip — short messages
/// don't over-correct, long messages don't under-correct.
private struct StickyOverlayHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// PreferenceKey for the y-position (in chat coord space) of the
/// `chat-bottom` sentinel — the actual rendered end of all chat rows.
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

    // MARK: - Scroll Tracers
    //
    // Foundation for the three scroll helpers (R1 growing-reply, R2 sticky
    // user bubble, R3 entry positioning). Populated lazily as the view
    // lays out; never touched directly by user input.

    /// User-bubble frames in the "chat" content coordinate space.
    @State private var userBubbleFrames: [String: CGRect] = [:]
    /// Content-space y of the viewport top (after content insets).
    @State private var scrollOffsetY: CGFloat = 0
    /// Visible viewport height (after content insets).
    @State private var viewportHeight: CGFloat = 0
    /// Total chat scroll content height (in content space). Used to
    /// detect "the agent reply for this turn is fully visible" for
    /// the latest user message — when content's bottom edge is at or
    /// above the viewport bottom, the pill is suppressed.
    @State private var chatContentHeight: CGFloat = 0

    // MARK: - R3 Entry State

    /// True once the entry-time scroll positioning has been performed for
    /// the current sessionId. Reset when sessionId changes.
    @State private var didInitialScroll = false

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
    /// Measured height of the rendered R2 sticky overlay (chip + top
    /// margin). Used by `stickyHandoffOffset` so the handoff band
    /// matches reality regardless of message length.
    @State private var stickyOverlayHeight: CGFloat = 0
    /// Whether the sticky overlay bubble is user-expanded past its
    /// max collapsed height. Resets each time the candidate changes.
    @State private var stickyExpanded: Bool = false
    /// ScrollPosition binding used for the tap-to-restore action so we
    /// can land the tapped user bubble's top exactly at the viewport
    /// top — the precise threshold where the natural pill-opacity rule
    /// hides the pill and reveals the original bubble in chat.
    @State private var chatScrollPosition: ScrollPosition = .init()
    /// Top content inset of the chat scroll view, tracked from
    /// `onScrollGeometryChange` so we can convert between our
    /// `scrollOffsetY` (which includes insets) and `ScrollPosition`'s
    /// raw content-offset y when issuing programmatic scrolls.
    @State private var chatScrollInsetTop: CGFloat = 0

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

    /// Whether older messages exist (first seq > 1).
    private var hasOlderMessages: Bool {
        let seqs = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }
        guard let first = seqs.min() else { return false }
        return first > 1
    }

    /// Session streaming content.
    private var streaming: String? {
        sessionStore.streamingContent[sessionId]
    }

    /// Grouped turn items.
    private var grouped: [TurnItem] {
        let raw = groupMessagesIntoTurns(filteredMessages)

        // Ensure streaming always attaches to a turn group
        guard streaming != nil else { return raw }
        if let last = raw.last, case .turn(let turn) = last, turn.finalMessage == nil {
            return raw
        }
        // Append an empty in-progress turn for streaming
        return raw + [.turn(Turn(id: "streaming", thinkingMessages: [], finalMessage: nil, isActive: true))]
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
                // Top spinner row — present whenever older messages
                // exist. While this row sits inside the viewport (i.e.
                // the user is near the top), the
                // `.onScrollGeometryChange` action fires `requestBefore`
                // continuously until either `firstSeq == 1` or the
                // spinner scrolls out of view.
                if hasOlderMessages {
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
            scrollOffsetY = m.offsetY
            viewportHeight = m.viewportHeight
            chatScrollInsetTop = m.insetTop
            chatContentHeight = m.contentHeight
            checkLockTransition(proxy: proxy)
            maybeAutoLoadOlder()
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
        .onChange(of: streaming) { _, _ in
            checkLockTransition(proxy: proxy)
        }
        .onChange(of: filteredMessages.count) { _, _ in
            // After each batch lands, if the top spinner is still
            // visible and older history still exists, kick off the
            // next page so we keep loading until either the spinner
            // scrolls out of view or we hit firstSeq=1.
            maybeAutoLoadOlder()
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

    // MARK: - Auto-load older messages

    /// Fire `requestBefore` continuously while the top spinner is
    /// in/near the viewport. Subsumes both web rules:
    ///   - "auto-load when content fits viewport" — if the content
    ///     fits, the spinner row is naturally at the top of the
    ///     viewport, so this triggers.
    ///   - "auto-load when user scrolls near top" — scrollOffsetY
    ///     drops below the spinner's threshold the moment it's
    ///     visible.
    /// The `messageProvider.isLoading` dedupe prevents thrash; the
    /// per-batch arrival re-decrements firstSeq and re-evaluates.
    private func maybeAutoLoadOlder() {
        guard hasOlderMessages else { return }
        guard !isLoading else { return }

        let firstSeq = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }.min() ?? Int.max
        guard firstSeq > 1 else { return }

        let threshold = Self.topSpinnerHeight + Self.topSpinnerSlop
        if scrollOffsetY < threshold {
            appState.messageProvider?.requestBefore(sessionId: sessionId, beforeSeq: firstSeq)
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
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: StickyOverlayHeightKey.self,
                            value: geo.size.height
                        )
                    }
                )
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
                .onPreferenceChange(StickyOverlayHeightKey.self) { h in
                    stickyOverlayHeight = h
                }
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
    private func entryScrollTarget() -> (id: String, anchor: UnitPoint)? {
        // 1. Last unanswered question (highest priority — user can act)
        for msg in filteredMessages.reversed() {
            if msg.type == "question" {
                let answer = msg.answer ?? ""
                let resolution = msg.resolution
                if answer.isEmpty && resolution == nil {
                    return (messageScrollId(msg), .top)
                }
            }
        }

        // 2. If idle, last user_message / send_input — read your own
        //    message → agent's reply naturally.
        if sessionIdle, let target = lastUserMessage {
            return (userScrollId(target), .top)
        }

        // 3. Last turn with a finalMessage — read the latest agent reply
        //    from the start.
        for msg in filteredMessages.reversed() {
            if msg.type == "agent_message" {
                // Only treat as a turn-final if it's the last
                // agent_message and followed only by idle/standalone
                // boundary types. Defensive — most "agent_message"
                // entries in an idle session ARE finals.
                return (messageScrollId(msg), .top)
            }
        }

        // 4. Fallback: bottom.
        return nil
    }

    private func performEntryScroll(proxy: ScrollViewProxy) async {
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
        scrollOffsetY = 0
        growMode = .idle
        lockedMsgId = nil
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
            didInitialScroll = true
            return
        }

        // Refresh baseline now that messages are actually loaded.
        lockedUserSeq = lastUserMessage?.seq ?? 0

        if wasUnread, let target = entryScrollTarget() {
            // Unread → land on a specific bubble at the top. The .top
            // anchor is stable across late content growth below the
            // target, so a single scrollTo is enough.
            proxy.scrollTo(target.id, anchor: target.anchor)
            didInitialScroll = true
        } else {
            // Read → land at the bottom. Content height typically
            // keeps growing for several hundred ms after the first
            // batch lands (MarkdownUI reflow, AsyncImage attachments
            // decoding, MessageBubbleView post-layout sizing, late
            // safe-area-inset measurement). If we flip
            // `didInitialScroll = true` right after a single
            // scrollTo, `currentScrollAnchor` switches to nil and
            // SwiftUI stops auto-pinning — leaving us frozen above
            // the eventual bottom by however much content grew.
            //
            // Strategy: keep re-scrolling to chat-bottom on each
            // layout tick until either chatContentHeight stops
            // changing for ~100ms or we hit a 750ms hard cap. While
            // this loop runs `currentScrollAnchor` is still
            // `.bottom`, so defaultScrollAnchor backs us up if a
            // proxy.scrollTo gets dropped. Animations disabled so
            // the repeated re-scrolls are silent corrections, not
            // visible bounces.
            scrollToBottomInstant(proxy: proxy)
            var prevHeight = chatContentHeight
            var stableTicks = 0
            let stabilityTarget = 4   // ~100ms
            let maxTicks = 30         // ~750ms
            var ticks = 0
            while ticks < maxTicks {
                try? await Task.sleep(for: .milliseconds(25))
                scrollToBottomInstant(proxy: proxy)
                if abs(chatContentHeight - prevHeight) < 0.5 {
                    stableTicks += 1
                    if stableTicks >= stabilityTarget { break }
                } else {
                    stableTicks = 0
                    prevHeight = chatContentHeight
                }
                ticks += 1
            }
            didInitialScroll = true
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
