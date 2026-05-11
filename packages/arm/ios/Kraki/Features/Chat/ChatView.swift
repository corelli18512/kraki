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
        let _ = KLog.d("🖥️ ChatView render: \(filteredMessages.count) msgs, \(grouped.count) groups, session=\(sessionId.prefix(12)), isOnline=\(isDeviceOnline)")
        scrollableMessages
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if isDeviceOnline {
                    bottomInputArea
                }
            }
            .background(Color.surfacePrimary)
    }

    // MARK: - Scrollable Messages

    private var scrollableMessages: some View {
        ScrollViewReader { proxy in
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
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.bottom)
            .coordinateSpace(name: "chat")
            .onScrollGeometryChange(for: ChatScrollMetrics.self) { geo in
                ChatScrollMetrics(
                    offsetY: geo.contentOffset.y + geo.contentInsets.top,
                    viewportHeight: geo.containerSize.height
                        - geo.contentInsets.top - geo.contentInsets.bottom
                )
            } action: { _, m in
                scrollOffsetY = m.offsetY
                viewportHeight = m.viewportHeight
            }
            .onPreferenceChange(UserBubbleFramesKey.self) { newFrames in
                userBubbleFrames = newFrames
            }
            .task(id: sessionId) {
                await performEntryScroll(proxy: proxy)
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

        // Snapshot unread BEFORE any await so SessionDetailView's deferred
        // markRead can't race ahead of us.
        let wasUnread = (sessionStore.unreadCounts[sessionId] ?? 0) > 0

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

        if wasUnread, let target = lastUserMessage {
            proxy.scrollTo(userScrollId(target), anchor: .top)
        } else {
            proxy.scrollTo("chat-bottom", anchor: .bottom)
        }
        didInitialScroll = true
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

#endif
