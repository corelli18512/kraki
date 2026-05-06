#if os(iOS)
/// MessageBubbleView — Renders individual chat messages, mirroring MessageBubble.tsx.
///
/// Dispatches on message type to produce the correct bubble style:
/// user messages right-aligned in blue, agent messages left-aligned with avatar,
/// system events centered, errors in red cards, etc.

import SwiftUI

struct MessageBubbleView: View {
    let message: ChatMessage
    var agent: String = ""
    var turnImages: [ImageAttachment]?
    var thinkingHistory: [ChatMessage] = []
    @Binding var historyExpanded: Bool
    var streamingText: String?
    @State private var solidCharCount: Int = 0
    @State private var batchTimestamp: Date = .distantPast

    @Environment(\.colorScheme) private var colorScheme

    // MARK: - Computed Properties

    private var visibleHistory: [ChatMessage] {
        thinkingHistory.filter { $0.type != "active" }
    }

    private var hasHistory: Bool { !visibleHistory.isEmpty }

    private var latestMessageText: String? {
        if let s = streamingText, !s.isEmpty { return s }
        if let c = message.content, !c.isEmpty { return c }
        return nil
    }

    private var trailingActivity: ChatMessage? {
        guard streamingText == nil || streamingText?.isEmpty == true else { return nil }
        guard let activity = visibleHistory.last(where: {
            $0.type == "tool_start" || $0.type == "tool_complete" || $0.type == "error"
        }) else { return nil }
        if activity.seq <= message.seq { return nil }
        return activity
    }

    private var agentBubbleColor: Color {
        .secondary.opacity(0.1)
    }

    var body: some View {
        switch message.type {
        case "user_message":
            userBubble(content: message.content, attachments: message.attachments, timestamp: message.timestamp)

        case "send_input":
            userBubble(
                content: message.payload["text"]?.stringValue,
                attachments: message.attachments,
                timestamp: message.timestamp
            )

        case "pending_input":
            pendingInputBubble

        case "agent_message":
            agentBubble

        case "session_created":
            sessionCreatedBanner

        case "session_ended":
            systemBanner(
                icon: "stop.circle.fill",
                iconColor: .secondary,
                text: "Session ended — \(message.payload["reason"]?.stringValue ?? "unknown")"
            )

        case "kill_session":
            systemBanner(icon: "xmark.circle.fill", iconColor: .red, text: "Session killed")

        case "error":
            errorCard

        case "answer":
            answerBubble

        case "permission":
            permissionBubble

        case "question":
            questionBubble

        case "tool_start":
            ToolActivityView(
                type: .start,
                toolName: message.toolName ?? "tool",
                args: message.args,
                result: nil
            )

        case "tool_complete":
            ToolActivityView(
                type: .complete,
                toolName: message.toolName ?? "tool",
                args: message.args,
                result: message.result
            )

        case "approve", "deny", "always_allow":
            EmptyView()

        default:
            EmptyView()
        }
    }

    // MARK: - User Bubble

    @ViewBuilder
    private func userBubble(content: String?, attachments: [ImageAttachment]?, timestamp: String?) -> some View {
        let showText = content != nil && content != "[image]"
        HStack {
            Spacer(minLength: UIScreen.main.bounds.width * 0.25)
            VStack(alignment: .trailing, spacing: 4) {
                if showText, let content {
                    Text(markdownContent(content))
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                }
                imageGrid(attachments: attachments)
                if let timestamp {
                    Text(formatTime(timestamp))
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.accentColor, in: bubbleShape(isUser: true))
            .contextMenu {
                if let content {
                    Button { UIPasteboard.general.string = content } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
            }
        }
    }

    // MARK: - Pending Input

    private var pendingInputBubble: some View {
        let text = message.payload["text"]?.stringValue
        let showText = text != nil && text != "[image]"
        return HStack {
            Spacer(minLength: UIScreen.main.bounds.width * 0.25)
            VStack(alignment: .trailing, spacing: 4) {
                if showText, let text {
                    Text(text)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                }
                imageGrid(attachments: message.attachments)
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.white.opacity(0.6))
                    Text("Sending…")
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.accentColor.opacity(0.7), in: bubbleShape(isUser: true))
        }
    }

    // MARK: - Agent Bubble

    private var agentBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            agentAvatar
            VStack(alignment: .leading, spacing: 0) {
                // Main content
                VStack(alignment: .leading, spacing: 4) {
                    if historyExpanded {
                        expandedContent
                    } else {
                        collapsedMessageContent
                    }
                    imageGrid(attachments: message.attachments)
                    if let turnImages, !turnImages.isEmpty {
                        imageGrid(attachments: turnImages)
                    }
                    if let timestamp = message.timestamp {
                        Text(formatTime(timestamp))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)

                // Trailing activity (when collapsed, if present)
                if !historyExpanded, let activity = trailingActivity {
                    VStack(alignment: .leading, spacing: 4) {
                        if activity.type == "error" {
                            ErrorLineView(message: activity, showPill: true)
                        } else {
                            ToolLineView(message: activity, showPill: true)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 0,
                            bottomLeadingRadius: 16,
                            bottomTrailingRadius: 16,
                            topTrailingRadius: 0
                        )
                        .fill(.black.opacity(colorScheme == .dark ? 0.2 : 0.06))
                    )
                }
            }
            .background(agentBubbleColor, in: bubbleShape(isUser: false))
            .overlay(alignment: .topLeading) {
                if hasHistory {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { historyExpanded.toggle() }
                    } label: {
                        Text("···")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(.ultraThinMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .offset(x: 8, y: -12)
                }
            }
            .contextMenu {
                if let content = message.content {
                    Button { UIPasteboard.general.string = content } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
            }
            Spacer(minLength: UIScreen.main.bounds.width * 0.15)
        }
    }

    // MARK: - Collapsed Message Content

    @ViewBuilder
    private var collapsedMessageContent: some View {
        if let streaming = streamingText, !streaming.isEmpty {
            streamingTextView(streaming)
        } else if let content = message.content {
            Text(markdownContent(content))
                .font(.subheadline)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
    }

    // MARK: - Expanded Content

    @ViewBuilder
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(visibleHistory.enumerated()), id: \.element.id) { _, item in
                    switch item.type {
                    case "agent_message":
                        if let content = item.content, !content.isEmpty {
                            Text(markdownContent(content))
                                .font(.subheadline)
                                .foregroundStyle(.primary.opacity(0.7))
                                .textSelection(.enabled)
                        }
                    case "tool_start", "tool_complete":
                        ToolLineView(message: item, showPill: true)
                    case "error":
                        ErrorLineView(message: item, showPill: true)
                    default:
                        EmptyView()
                    }
                }
            }
            .padding(10)
            .background(.black.opacity(colorScheme == .dark ? 0.2 : 0.06), in: RoundedRectangle(cornerRadius: 8))

            // Final message
            if let streaming = streamingText, !streaming.isEmpty {
                streamingTextView(streaming)
            } else if let content = message.content, !content.isEmpty {
                Text(markdownContent(content))
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: - Streaming Text (cascade word fade)

    private func streamingTextView(_ text: String) -> some View {
        TimelineView(.animation) { timeline in
            let words = text.splitKeepingSpaces()
            let now = timeline.date
            let elapsed = now.timeIntervalSince(batchTimestamp)
            let totalSolid = min(words.count, solidCharCount + Int(elapsed * 30))

            Text(words.enumerated().reduce(AttributedString()) { result, pair in
                let (i, word) = pair
                var attr = AttributedString(word)
                if i >= totalSolid {
                    let fadeIndex = i - totalSolid
                    let opacity = max(0, min(1, 1.0 - Double(fadeIndex) / 3.0))
                    attr.foregroundColor = .primary.opacity(opacity)
                } else {
                    attr.foregroundColor = .primary
                }
                return result + attr
            })
            .font(.subheadline)
            .textSelection(.enabled)
            .onChange(of: text.count) { oldCount, newCount in
                if newCount > oldCount {
                    solidCharCount = max(0, words.count - 3)
                    batchTimestamp = .now
                }
            }
        }
    }

    // MARK: - Agent Avatar

    private var agentAvatar: some View {
        AgentAvatar(agent: agent, sessionId: message.sessionId, size: .sm)
    }

    // MARK: - Session Created

    private var sessionCreatedBanner: some View {
        let agentName = message.payload["agent"]?.stringValue ?? "Agent"
        let forked = message.payload["forked"]?.boolValue == true || message.seq > 1
        let model = message.payload["model"]?.stringValue
        return HStack(spacing: 4) {
            Spacer()
            AgentAvatar(agent: agentName, sessionId: message.sessionId, size: .sm)
            Text("\(agentLabel(agentName)) session \(forked ? "forked" : "started")")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let model {
                Text("(\(model))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 6)
    }

    // MARK: - System Banner

    private func systemBanner(icon: String, iconColor: Color, text: String) -> some View {
        HStack(spacing: 4) {
            Spacer()
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(iconColor)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 4)
    }

    // MARK: - Error Card

    private var errorCard: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Error")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.red)
                Text(message.errorMessage ?? "Unknown error")
                    .font(.subheadline)
                    .foregroundStyle(.red.opacity(0.8))
            }
            Spacer()
        }
        .padding(12)
        .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(.red.opacity(0.3), lineWidth: 1)
        )
    }

    // MARK: - Answer Bubble

    private var answerBubble: some View {
        HStack {
            Spacer(minLength: UIScreen.main.bounds.width * 0.15)
            VStack(alignment: .trailing, spacing: 4) {
                Text("Answer")
                    .font(.system(size: 10))
                    .fontWeight(.medium)
                    .foregroundStyle(.white.opacity(0.7))
                Text(message.answer ?? "")
                    .font(.subheadline)
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.accentColor.opacity(0.85), in: bubbleShape(isUser: true))
        }
    }

    // MARK: - Permission Bubble

    @ViewBuilder
    private var permissionBubble: some View {
        let resolution = message.resolution
        let toolName = message.toolName ?? "tool"
        let desc = permissionDescription(toolName: toolName, args: message.args, desc: message.toolDescription)

        if let resolution {
            // Resolved permission
            let isApproved = resolution == "approved" || resolution == "always_allowed"
            let isCancelled = resolution == "cancelled"
            let bgColor: Color = isApproved ? .green : isCancelled ? .gray : .red
            let label = resolution == "approved" ? "Approved"
                : resolution == "always_allowed" ? "Allowed for session"
                : resolution == "cancelled" ? "Cancelled"
                : "Denied"
            let resolvedIcon: LucideIconType = resolution == "always_allowed" ? .lockOpen
                : isCancelled ? .circleStop
                : isApproved ? .check : .x

            HStack {
                Spacer(minLength: UIScreen.main.bounds.width * 0.15)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 4) {
                        LucideIcon(resolvedIcon, size: 12, color: isApproved ? .green : isCancelled ? .secondary : .red)
                        Text(label)
                            .font(.caption)
                            .fontWeight(.medium)
                        Text("·")
                        Text(toolName)
                            .font(.caption)
                            .fontDesign(.monospaced)
                    }
                    .foregroundStyle(isApproved ? .green : isCancelled ? .secondary : .red)

                    Text(desc)
                        .font(.subheadline)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.primary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(bgColor.opacity(0.1), in: bubbleShape(isUser: true))
            }
        } else {
            // Pending permission (normally hidden behind blocking card)
            HStack(alignment: .top, spacing: 8) {
                LucideIcon(.lock, size: 14, color: .orange)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 4) {
                        Text("Permission requested")
                            .font(.caption)
                            .fontWeight(.medium)
                        Text("·")
                        Text(toolName)
                            .font(.caption)
                            .fontDesign(.monospaced)
                    }
                    .foregroundStyle(.orange)
                    Text(desc)
                        .font(.subheadline)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.primary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.orange.opacity(0.1), in: bubbleShape(isUser: false))
                Spacer(minLength: UIScreen.main.bounds.width * 0.15)
            }
        }
    }

    // MARK: - Question Bubble

    @ViewBuilder
    private var questionBubble: some View {
        VStack(spacing: 8) {
            // Question (agent-aligned)
            HStack(alignment: .top, spacing: 8) {
                agentAvatar
                VStack(alignment: .leading, spacing: 4) {
                    Text(message.question ?? "")
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    if let timestamp = message.timestamp {
                        Text(formatTime(timestamp))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.secondary.opacity(0.1), in: bubbleShape(isUser: false))
                Spacer(minLength: UIScreen.main.bounds.width * 0.15)
            }

            // Answer (if provided)
            if let answer = message.answer {
                HStack {
                    Spacer(minLength: UIScreen.main.bounds.width * 0.15)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(answer)
                            .font(.subheadline)
                            .foregroundStyle(.white)
                        if let timestamp = message.timestamp {
                            Text(formatTime(timestamp))
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.6))
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.accentColor, in: bubbleShape(isUser: true))
                }
            }
        }
    }

    // MARK: - Image Grid

    @ViewBuilder
    private func imageGrid(attachments: [ImageAttachment]?) -> some View {
        let images = attachments?.filter { $0.type == "image" } ?? []
        if !images.isEmpty {
            HStack(spacing: 6) {
                ForEach(Array(images.enumerated()), id: \.offset) { _, img in
                    if let imageData = Data(base64Encoded: img.data),
                       let uiImage = UIImage(data: imageData) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 192)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    private func bubbleShape(isUser: Bool) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 16,
            bottomLeadingRadius: isUser ? 16 : 4,
            bottomTrailingRadius: isUser ? 4 : 16,
            topTrailingRadius: 16
        )
    }

    private func formatTime(_ timestamp: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fmt.date(from: timestamp) else { return timestamp }
        let displayFmt = DateFormatter()
        displayFmt.dateFormat = "h:mm a"
        return displayFmt.string(from: date)
    }

    private func markdownContent(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(text)
    }

    private func agentLabel(_ agent: String) -> String {
        AgentInfo.from(agent).label
    }

    private func permissionDescription(toolName: String, args: [String: AnyCodable]?, desc: String?) -> String {
        if let desc, !desc.isEmpty, desc != "Run:", desc != "Run: " {
            return desc
        }
        let summary = permissionArgsSummary(toolName: toolName, args: args)
        if !summary.isEmpty {
            return "Run: \(summary)"
        }
        return "Run \(toolName)"
    }

    private func permissionArgsSummary(toolName: String, args: [String: AnyCodable]?) -> String {
        guard let args else { return "" }
        if (toolName == "shell" || toolName == "bash"),
           let cmd = args["command"]?.stringValue, !cmd.isEmpty {
            return cmd
        }
        if (toolName == "write_file" || toolName == "read_file" || toolName == "edit"),
           let path = args["path"]?.stringValue, !path.isEmpty {
            return path
        }
        if let cmd = args["command"]?.stringValue, !cmd.isEmpty { return cmd }
        if let path = args["path"]?.stringValue, !path.isEmpty { return path }
        return ""
    }
}

// MARK: - String helpers

extension String {
    /// Splits a string into words while keeping trailing spaces attached.
    func splitKeepingSpaces() -> [String] {
        var words: [String] = []
        var current = ""
        for char in self {
            if char == " " {
                current.append(char)
                words.append(current)
                current = ""
            } else {
                current.append(char)
            }
        }
        if !current.isEmpty { words.append(current) }
        return words
    }
}

// MARK: - ToolLineView

private struct ToolLineView: View {
    let message: ChatMessage
    var showPill: Bool = false

    @State private var expanded = false

    private var toolName: String { message.toolName ?? "tool" }
    private var isComplete: Bool { message.type == "tool_complete" }
    private var isError: Bool { message.result?.hasPrefix("Error") == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    statusIcon
                    Text(toolName)
                        .font(.system(size: 12, design: .monospaced))
                        .fontWeight(.medium)
                        .foregroundStyle(.blue)

                    if let detail = toolDetail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: 0)

                    if hasExpandableContent {
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 0 : -90))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                expandedBody
            }
        }
        .padding(showPill ? 8 : 0)
        .background(showPill ? AnyShapeStyle(.quaternary.opacity(0.5)) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var statusIcon: some View {
        if isComplete {
            if isError {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            }
        } else {
            ProgressView()
                .controlSize(.mini)
        }
    }

    private var toolDetail: String? {
        guard let args = message.args else { return nil }
        if let cmd = args["command"]?.stringValue { return "$ \(cmd)" }
        if let path = args["path"]?.stringValue { return path }
        return nil
    }

    private var hasExpandableContent: Bool {
        message.args != nil || (message.result != nil && !message.result!.isEmpty)
    }

    @ViewBuilder
    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let args = message.args {
                let oldStr = args["old_str"]?.stringValue ?? ""
                let newStr = args["new_str"]?.stringValue ?? ""
                if !oldStr.isEmpty || !newStr.isEmpty {
                    SimpleDiffView(oldText: oldStr, newText: newStr)
                } else {
                    let detail = args.sorted { $0.key < $1.key }
                        .map { "\($0.key): \($0.value)" }
                        .joined(separator: "\n")
                    Text(detail)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            if let result = message.result, !result.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Result")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    ScrollView {
                        Text(result)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 200)
                }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}

// MARK: - ErrorLineView

private struct ErrorLineView: View {
    let message: ChatMessage
    var showPill: Bool = false

    @State private var expanded = false

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                Text(message.errorMessage ?? "Error")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.red.opacity(0.8))
                    .lineLimit(expanded ? nil : 1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(showPill ? 8 : 0)
        .background(showPill ? AnyShapeStyle(.quaternary.opacity(0.5)) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - PulseModifier

struct PulseModifier: ViewModifier {
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? 0.4 : 1.0)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: isPulsing)
            .onAppear { isPulsing = true }
    }
}

extension View {
    func pulse() -> some View {
        modifier(PulseModifier())
    }
}

#endif
