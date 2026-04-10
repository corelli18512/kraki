#if os(iOS)
/// ChatView — Main chat interface for a session, mirroring ChatView.tsx.
///
/// Groups messages into turns, renders thinking boxes and message bubbles,
/// handles auto-scroll, gap markers, and the blocking input stack at the bottom
/// (permissions → questions → message input).

import SwiftUI

struct ChatView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState
    @State private var showScrollButton = false
    @State private var unreadCount = 0
    @State private var isAtBottom = true
    @State private var previousGroupCount = 0
    @State private var previousLastSeq = 0

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

    /// IDs of pending permissions so we can filter them from the message list.
    private var pendingPermissionIds: Set<String> {
        Set(permissions.map(\.id))
    }

    /// Messages for this session, filtering out pending permission bubbles.
    private var filteredMessages: [ChatMessage] {
        let messages = messageStore.messages[sessionId] ?? []
        return messages.filter { msg in
            if msg.type == "permission", let pid = msg.permissionId, pendingPermissionIds.contains(pid) {
                return false
            }
            return true
        }
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

    var body: some View {
        let _ = KLog.d("🖥️ ChatView render: \(filteredMessages.count) msgs, \(grouped.count) groups, session=\(sessionId.prefix(12)), isOnline=\(isDeviceOnline)")
        VStack(spacing: 0) {
            // Messages area
            ZStack(alignment: .bottomTrailing) {
                scrollableMessages

                // Dim overlay when blocking cards are shown
                if !permissions.isEmpty || !questions.isEmpty {
                    Color.black.opacity(0.05)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }

                // Scroll to bottom button
                if showScrollButton {
                    scrollToBottomButton
                        .padding(12)
                        .transition(.scale.combined(with: .opacity))
                }
            }

            // Bottom input area
            if isDeviceOnline {
                bottomInputArea
            }
        }
        .onChange(of: sessionId) {
            showScrollButton = false
            unreadCount = 0
            isAtBottom = true
        }
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
                            MessageBubbleView(
                                message: msg,
                                agent: session?.agent ?? ""
                            )

                        case .turn(let turn):
                            let isLastTurn = idx == grouped.count - 1
                            let hasStreaming = isLastTurn && streaming != nil
                            let isActive = isLastTurn && !sessionIdle && (turn.finalMessage == nil || hasStreaming)

                            VStack(spacing: 8) {
                                if !turn.thinkingMessages.isEmpty || hasStreaming {
                                    ThinkingBoxView(
                                        messages: turn.thinkingMessages,
                                        isActive: isActive,
                                        agent: session?.agent ?? "",
                                        streamingText: hasStreaming ? streaming : nil
                                    )
                                }

                                if let final = turn.finalMessage, !hasStreaming {
                                    MessageBubbleView(
                                        message: final,
                                        agent: session?.agent ?? "",
                                        turnImages: collectTurnImages(turn.thinkingMessages)
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
            .onAppear {
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
            .onChange(of: grouped.count) { oldCount, newCount in
                handleNewMessages(proxy: proxy, oldCount: oldCount, newCount: newCount)
            }
            .onChange(of: streaming) {
                if isAtBottom {
                    withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
            }
        }
    }

    // MARK: - Scroll to Bottom Button

    private var scrollToBottomButton: some View {
        Button {
            // Trigger scroll by resetting state
            showScrollButton = false
            unreadCount = 0
            isAtBottom = true
        } label: {
            HStack(spacing: 6) {
                if unreadCount > 0 {
                    Text("\(unreadCount)")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 2)
                        .background(Color.accentColor, in: Capsule())
                }
                Image(systemName: "arrow.down")
                    .font(.caption)
                    .fontWeight(.semibold)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.15), radius: 8, y: 4)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Bottom Input Area

    @ViewBuilder
    private var bottomInputArea: some View {
        if !permissions.isEmpty {
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(permissions) { perm in
                        PermissionCardView(permission: perm)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .frame(maxHeight: UIScreen.main.bounds.height * 0.4)
        } else if let question = questions.first {
            QuestionCardView(question: question)
        } else {
            VStack(spacing: 6) {
                if sessionIdle && !filteredMessages.isEmpty {
                    QuickRepliesView(sessionId: sessionId)
                        .padding(.horizontal, 16)
                }
                MessageInputView(sessionId: sessionId)
            }
        }
    }

    // MARK: - Helpers

    private func handleNewMessages(proxy: ScrollViewProxy, oldCount: Int, newCount: Int) {
        guard newCount > oldCount else { return }

        // Check if user sent the message (auto-scroll regardless)
        if let last = grouped.last, case .standalone(let msg) = last,
           ["user_message", "pending_input", "answer", "send_input"].contains(msg.type) {
            withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            return
        }

        if isAtBottom {
            withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
        } else {
            unreadCount += (newCount - oldCount)
            showScrollButton = true
        }
    }

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
