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

/// Compact, Equatable snapshot of the metrics we care about from the
/// ScrollView. Used as the change-trigger value for
/// `.onScrollGeometryChange`.
private struct ChatScrollMetrics: Equatable {
    var offsetY: CGFloat
    var viewportHeight: CGFloat
}

struct ChatView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState
    @State private var expandedTurns: Set<String> = []

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

    var body: some View {
        ScrollViewReader { proxy in
            scrollableMessages(proxy: proxy)
                .overlay(alignment: .top) {
                    stickyUserOverlay(proxy: proxy)
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if isDeviceOnline {
                        bottomInputArea
                    }
                }
                .background(Color.surfacePrimary)
        }
    }

    // MARK: - Scrollable Messages

    private func scrollableMessages(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                // Load older messages button
                if hasOlderMessages {
                    Button {
                        let firstSeq = filteredMessages.compactMap { $0.seq > 0 ? $0.seq : nil }.min() ?? 1
                        appState.messageProvider?.requestBefore(sessionId: sessionId, beforeSeq: firstSeq)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.up.circle")
                                .font(.caption)
                            Text("Load older messages")
                                .font(.caption)
                                .fontWeight(.medium)
                        }
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
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
        .onScrollGeometryChange(for: ChatScrollMetrics.self) { geo in
            ChatScrollMetrics(
                offsetY: geo.contentOffset.y + geo.contentInsets.top,
                viewportHeight: geo.containerSize.height
                    - geo.contentInsets.top - geo.contentInsets.bottom
            )
        } action: { _, m in
            scrollOffsetY = m.offsetY
            viewportHeight = m.viewportHeight
            checkLockTransition(proxy: proxy)
        }
        .onScrollPhaseChange { _, newPhase in
            // Any direct user contact with the scroll view ends R1.
            if newPhase == .interacting && growMode != .idle {
                growMode = .idle
            }
        }
        .onPreferenceChange(UserBubbleFramesKey.self) { newFrames in
            // Merge: LazyVStack destroys the GeometryReader for recycled
            // (off-screen) rows, so `newFrames` only contains currently
            // realized cells. Replacing the dictionary would wipe the
            // positions of bubbles that have scrolled out of view —
            // exactly when R2 needs them. Instead we merge: update
            // entries with fresh non-empty frames, but never drop an
            // entry just because its row was recycled. Stale entries
            // are pruned explicitly on session change / message-list
            // changes.
            var merged = userBubbleFrames
            for (id, frame) in newFrames where frame.height > 0 {
                merged[id] = frame
            }
            userBubbleFrames = merged
            checkLockTransition(proxy: proxy)
        }
        .onChange(of: lastUserMessage?.seq ?? 0) { _, newSeq in
            handleNewUserMessage(proxy: proxy, seq: newSeq)
        }
        .onChange(of: filteredMessages.count) { _, _ in
            // Prune cached frames for messages that no longer exist.
            let liveIds = Set(filteredMessages.map(\.id))
            userBubbleFrames = userBubbleFrames.filter { liveIds.contains($0.key) }
            checkLockTransition(proxy: proxy)
        }
        .onChange(of: streaming) { _, _ in
            checkLockTransition(proxy: proxy)
        }
        .onChange(of: sessionIdle) { _, idle in
            // Turn complete — release the lock so the next user
            // message can trigger a fresh followBottom phase.
            if idle && growMode != .idle {
                growMode = .idle
            }
        }
        .task(id: sessionId) {
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

    // MARK: - R2: Sticky User Bubble Overlay
    //
    // When the user scrolls back through a long agent reply, pin a
    // glass-backed copy of the most recent user message that has
    // scrolled above the viewport top. Re-uses the same frame tracers
    // that R1 populates.
    //
    // Visibility is driven by how far the candidate's original position
    // has scrolled ABOVE the viewport top (`aboveAmount`):
    //   - aboveAmount <= stickyFadeStart → opacity 0 (pill hidden)
    //   - aboveAmount in (stickyFadeStart, stickyFadeEnd) → linear ramp
    //   - aboveAmount >= stickyFadeEnd → opacity 1 (fully visible)
    //
    // This keeps the R1-LOCKED state clean (the locked bubble has
    // aboveAmount=0, so no pill renders on top of it) and only "lifts
    // off" once the user scrolls further past the bubble's own row.

    /// Outer margin around the sticky overlay.
    fileprivate static let stickyMargin: CGFloat = 8
    /// Pill stays hidden until the candidate has scrolled this many
    /// points above the viewport top.
    fileprivate static let stickyFadeStart: CGFloat = 80
    /// Pill reaches full opacity once the candidate is this far above.
    fileprivate static let stickyFadeEnd: CGFloat = 160

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

    /// Distance-driven opacity. 0 while the candidate is still at or
    /// near its natural position; ramps to 1 once the user has scrolled
    /// the candidate at least `stickyFadeEnd` pt above viewport top.
    private var stickyOpacity: Double {
        guard let candidate = stickyCandidate,
              let frame = userBubbleFrames[candidate.id] else { return 0 }
        let aboveAmount = scrollOffsetY - frame.minY
        let span = Self.stickyFadeEnd - Self.stickyFadeStart
        let progress = (aboveAmount - Self.stickyFadeStart) / span
        return Double(max(0, min(1, progress)))
    }

    @ViewBuilder
    private func stickyUserOverlay(proxy: ScrollViewProxy) -> some View {
        if let msg = stickyCandidate {
            StickyUserBubble(message: msg)
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
                .contentShape(Rectangle())
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        proxy.scrollTo(userScrollId(msg), anchor: .top)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
                .animation(.easeOut(duration: 0.18), value: msg.id)
                .allowsHitTesting(stickyOpacity > 0.5)
                .onPreferenceChange(StickyOverlayHeightKey.self) { h in
                    stickyOverlayHeight = h
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
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: UserBubbleFramesKey.self,
                            value: [msg.id: geo.frame(in: .named("chat"))]
                        )
                    }
                )
        } else {
            bubble
        }
    }

    /// Stable ScrollView target id for a user message bubble.
    private func userScrollId(_ msg: ChatMessage) -> String {
        "user-\(msg.id)"
    }

    // MARK: - R3: Entry Positioning
    //
    // On first non-empty render of a session:
    //   - if unread → scroll to last user message at viewport top
    //   - else      → scroll to bottom (keeps existing behavior)
    //
    // Race note: SessionDetailView.onAppear calls markRead which clears
    // unreadCounts. SessionDetailView dispatches markRead inside a
    // `Task { @MainActor in ... }` so this .task captures the unread
    // value first. The capture itself is synchronous at the top of this
    // function before any awaits.

    private func performEntryScroll(proxy: ScrollViewProxy) async {
        // Reset on session switch (.task(id:) re-runs when sessionId changes)
        didInitialScroll = false
        userBubbleFrames = [:]
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
            return (sessionStore.unreadCounts[sessionId] ?? 0) > 0
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

        if wasUnread, let target = lastUserMessage {
            proxy.scrollTo(userScrollId(target), anchor: .top)
        } else {
            proxy.scrollTo("chat-bottom", anchor: .bottom)
        }
        didInitialScroll = true
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
        sawBubbleBelowTop = false
        // Drop any stale GeometryReader sample so checkLockTransition
        // waits for a real, post-layout frame before deciding to lock.
        userBubbleFrames.removeValue(forKey: msg.id)
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

    private var content: String? {
        if message.type == "send_input" {
            return message.payload["text"]?.stringValue
        }
        return message.content
    }

    var body: some View {
        HStack {
            Spacer(minLength: UIScreen.main.bounds.width * 0.25)
            VStack(alignment: .trailing, spacing: 4) {
                if let text = content, !text.isEmpty, text != "[image]" {
                    Text(markdown(text))
                        .font(.subheadline)
                        .foregroundStyle(.white)
                } else {
                    Text("Photo")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .modifier(StickyGlassPillModifier(tint: Color.accentColor))
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
        .padding(.horizontal, 12)
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(text)
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
