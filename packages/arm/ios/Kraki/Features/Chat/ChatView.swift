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
    @State private var expandedTurns: Set<String> = []

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
                            MessageBubbleView(
                                message: msg,
                                agent: session?.agent ?? "",
                                historyExpanded: .constant(false)
                            )

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
            .onAppear {
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
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

#endif
