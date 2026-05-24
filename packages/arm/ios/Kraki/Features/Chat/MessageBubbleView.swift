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

    /// Items before the final message (top history section)
    private var preMessageHistory: [ChatMessage] {
        visibleHistory.filter { $0.seq <= message.seq }
    }

    /// Items after the final message (bottom tool section)
    private var postMessageActivity: [ChatMessage] {
        guard streamingText == nil || streamingText?.isEmpty == true else { return [] }
        return visibleHistory.filter { $0.seq > message.seq }
    }

    private var hasHistory: Bool { !preMessageHistory.isEmpty }

    /// Whether the bubble has anything that can be expanded/collapsed via the
    /// context menu: either pre-message history (hidden when collapsed) or
    /// more than one post-message activity item (only the latest shows when
    /// collapsed).
    private var canToggleSteps: Bool {
        hasHistory || postMessageActivity.count > 1
    }

    private var latestMessageText: String? {
        if let s = streamingText, !s.isEmpty { return s }
        if let c = message.content, !c.isEmpty { return c }
        return nil
    }

    /// True when the agent has produced any text yet (streaming or final).
    private var hasMessageContent: Bool { latestMessageText != nil }

    /// When the agent hasn't said anything yet but already has tool activity,
    /// hide the empty "..." message section and let the tool section fill the
    /// bubble.
    private var hideMessageSection: Bool {
        !hasMessageContent && !postMessageActivity.isEmpty
    }

    private var agentBubbleColor: Color {
        let hue = stringToHue(message.sessionId ?? agent) / 360
        let (h, s, b) = hslToHSB(
            h: hue,
            s: colorScheme == .dark ? 0.35 : 0.40,
            l: colorScheme == .dark ? 0.18 : 0.93
        )
        return Color(hue: h, saturation: s, brightness: b)
    }

    private var sectionTintColor: Color {
        let hue = stringToHue(message.sessionId ?? agent) / 360
        let (h, s, b) = hslToHSB(
            h: hue,
            s: colorScheme == .dark ? 0.40 : 0.30,
            l: colorScheme == .dark ? 0.13 : 0.97
        )
        return Color(hue: h, saturation: s, brightness: b)
    }

    /// Higher-contrast variant of the bubble hue for context-menu icon tint.
    /// The bubble itself uses a soft wash that's nearly invisible against
    /// menu blur material; this version is saturated/lifted enough to read.
    private var agentAccentColor: Color {
        let hue = stringToHue(message.sessionId ?? agent) / 360
        let (h, s, b) = hslToHSB(
            h: hue,
            s: colorScheme == .dark ? 0.75 : 0.70,
            l: colorScheme == .dark ? 0.65 : 0.45
        )
        return Color(hue: h, saturation: s, brightness: b)
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
                headline: message.headline,
                argsRef: message.argsRef,
                resultRef: nil,
                inlineArgs: message.args,
                sessionId: message.sessionId ?? ""
            )

        case "tool_complete":
            ToolActivityView(
                type: .complete,
                toolName: message.toolName ?? "tool",
                headline: message.headline,
                argsRef: message.argsRef,
                resultRef: message.resultRef,
                inlineArgs: message.args,
                sessionId: message.sessionId ?? ""
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
        return HStack {
            Spacer(minLength: UIScreen.main.bounds.width * 0.10)
            VStack(alignment: .trailing, spacing: 4) {
                if showText, let content {
                    Text(markdownContent(content))
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                }
                imageGrid(attachments: attachments)
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
            .tint(.accentColor)
        }
    }

    // MARK: - Pending Input

    private var pendingInputBubble: some View {
        let text = message.payload["text"]?.stringValue
        let showText = text != nil && text != "[image]"
        return HStack {
            Spacer(minLength: UIScreen.main.bounds.width * 0.10)
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
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                // ① History section (top) — pre-message items, collapsed by default
                if historyExpanded && !preMessageHistory.isEmpty {
                    bubbleSection(position: .top) {
                        ForEach(Array(preMessageHistory.enumerated()), id: \.element.id) { _, item in
                            historyItemView(item)
                        }
                    }
                }

                // ② Message section (middle) — hidden when the agent has no text
                //    yet but already has tool activity, so the tool section can
                //    fill the bubble cleanly instead of an animated "...".
                if !hideMessageSection {
                    VStack(alignment: .leading, spacing: 4) {
                        messageContent
                        imageGrid(attachments: message.attachments)
                        if let turnImages, !turnImages.isEmpty {
                            imageGrid(attachments: turnImages)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }

                // ③ Tool section (bottom) — post-message activity
                if !postMessageActivity.isEmpty {
                    let topSectionShown = historyExpanded && !preMessageHistory.isEmpty
                    let bottomAtBubbleTop = hideMessageSection && !topSectionShown
                    bubbleSection(position: .bottom, atBubbleTop: bottomAtBubbleTop) {
                        if historyExpanded {
                            ForEach(Array(postMessageActivity.enumerated()), id: \.element.id) { _, item in
                                historyItemView(item)
                            }
                        } else {
                            historyItemView(postMessageActivity.last!)
                        }
                    }
                }
            }
            .background(agentBubbleColor, in: bubbleShape(isUser: false))
            .contentShape(bubbleShape(isUser: false))
            .onTapGesture(count: 2) {
                guard canToggleSteps else { return }
                withAnimation(.easeInOut(duration: 0.2)) { historyExpanded.toggle() }
            }
            .contextMenu {
                if let content = message.content {
                    Button { UIPasteboard.general.string = content } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
                if canToggleSteps {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { historyExpanded.toggle() }
                    } label: {
                        if historyExpanded {
                            Label("Collapse Steps", systemImage: "chevron.up.circle")
                        } else {
                            Label("Expand Steps", systemImage: "chevron.down.circle")
                        }
                    }
                }
            }
            .tint(agentAccentColor)
            Spacer(minLength: UIScreen.main.bounds.width * 0.05)
        }
    }

    // MARK: - Message Content

    @ViewBuilder
    private var messageContent: some View {
        if let streaming = streamingText, !streaming.isEmpty {
            streamingTextView(streaming)
        } else if let content = message.content, !content.isEmpty {
            Text(markdownContent(content))
                .font(.subheadline)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        } else {
            TypingDotsView()
        }
    }

    // MARK: - History Item View (shared renderer for tool/error/agent_message)

    @ViewBuilder
    private func historyItemView(_ item: ChatMessage) -> some View {
        switch item.type {
        case "agent_message":
            if let content = item.content, !content.isEmpty {
                Text(markdownContent(content))
                    .font(.subheadline)
                    .foregroundStyle(.primary.opacity(0.7))
                    .textSelection(.enabled)
            }
        case "tool_start", "tool_complete":
            ToolLineView(message: item)
        case "error":
            ErrorLineView(message: item)
        case "question":
            QuestionLineView(message: item)
        case "permission":
            PermissionLineView(message: item)
        case "question_resolved", "answer", "approve", "deny", "always_allow", "permission_resolved":
            EmptyView() // These are structural — the original message carries the visible result
        default:
            EmptyView()
        }
    }

    // MARK: - Bubble Section (top or bottom darker area)

    private enum SectionPosition { case top, bottom }

    /// `atBubbleTop` is only meaningful for `.bottom`: when the bottom section
    /// is the *only* thing in the bubble (no message above), its top corners
    /// must match the agent bubble shape (4 leading / 16 trailing) instead of
    /// being sharp.
    private func bubbleSection<Content: View>(
        position: SectionPosition,
        atBubbleTop: Bool = false,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            content()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            UnevenRoundedRectangle(
                topLeadingRadius: position == .top ? 4 : (atBubbleTop ? 4 : 0),
                bottomLeadingRadius: position == .bottom ? 16 : 0,
                bottomTrailingRadius: position == .bottom ? 16 : 0,
                topTrailingRadius: position == .top ? 16 : (atBubbleTop ? 16 : 0)
            )
            .fill(sectionTintColor)
        )
    }

    // MARK: - Streaming Text (cascade word fade)

    private struct StreamToken {
        let text: String
        let headingLevel: Int
    }

    private func streamTokens(_ text: String) -> [StreamToken] {
        var tokens: [StreamToken] = []
        let lines = text.components(separatedBy: "\n")
        for (li, line) in lines.enumerated() {
            let level = streamHeadingLevel(line)
            let content = level > 0 ? String(line.dropFirst(level + 1)) : line
            for w in content.splitKeepingSpaces() {
                tokens.append(StreamToken(text: w, headingLevel: level))
            }
            if li < lines.count - 1 {
                tokens.append(StreamToken(text: "\n", headingLevel: 0))
            }
        }
        return tokens
    }

    private func streamHeadingLevel(_ line: String) -> Int {
        var level = 0
        for ch in line {
            if ch == "#", level < 6 { level += 1 } else { break }
        }
        guard level > 0 else { return 0 }
        let afterIdx = line.index(line.startIndex, offsetBy: level)
        return afterIdx < line.endIndex && line[afterIdx] == " " ? level : 0
    }

    private func streamHeadingFont(level: Int) -> Font {
        switch level {
        case 1: return .title2.bold()
        case 2: return .title3.bold()
        case 3: return .headline
        case 4: return .subheadline.bold()
        default: return .footnote.bold()
        }
    }

    private func streamingTextView(_ text: String) -> some View {
        TimelineView(.animation) { timeline in
            let tokens = streamTokens(text)
            let now = timeline.date
            let elapsed = now.timeIntervalSince(batchTimestamp)
            let totalSolid = min(tokens.count, solidCharCount + Int(elapsed * 30))

            Text(tokens.enumerated().reduce(AttributedString()) { result, pair in
                let (i, tok) = pair
                var attr = AttributedString(tok.text)
                if tok.headingLevel > 0 {
                    attr.font = streamHeadingFont(level: tok.headingLevel)
                }
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
                    solidCharCount = max(0, tokens.count - 3)
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
            AgentAvatar(agent: agentName, sessionId: message.sessionId, size: .xs)
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
        // Standalone permission bubble (used when a permission message isn't
        // bundled inside a turn). Same agent-aligned shape for pending and
        // resolved states so the resolve doesn't flip sides — visually it
        // morphs in place, mirroring how questionBubble handles answers.
        let toolName = message.toolName ?? "tool"
        let desc = permissionDescription(toolName: toolName, args: message.args, desc: message.toolDescription)
        let resolution = message.resolution
        let palette = permissionPalette(for: resolution)

        HStack(alignment: .top, spacing: 8) {
            LucideIcon(palette.icon, size: 14, color: palette.color)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Text(palette.label)
                        .font(.caption)
                        .fontWeight(.medium)
                    Text("·")
                    Text(toolName)
                        .font(.caption)
                        .fontDesign(.monospaced)
                }
                .foregroundStyle(palette.color)
                Text(desc)
                    .font(.subheadline)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(palette.color.opacity(0.1), in: bubbleShape(isUser: false))
            Spacer(minLength: UIScreen.main.bounds.width * 0.15)
        }
    }

    private func permissionPalette(for resolution: String?) -> (icon: LucideIconType, color: Color, label: String) {
        switch resolution {
        case "approved":        return (.check,      .green,     "Approved")
        case "always_allowed":  return (.lockOpen,   .green,     "Allowed for session")
        case "denied":          return (.x,          .red,       "Denied")
        case "cancelled":       return (.circleStop, .secondary, "Cancelled")
        default:                return (.lock,       .orange,    "Permission requested")
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
        let inlineImages = (attachments ?? []).filter { $0.type == "image" }
        let refImages = message.contentRefAttachments.filter {
            $0.mimeType.hasPrefix("image/")
        }
        if !inlineImages.isEmpty || !refImages.isEmpty {
            HStack(spacing: 6) {
                ForEach(Array(inlineImages.enumerated()), id: \.offset) { _, img in
                    if let imageData = Data(base64Encoded: img.data),
                       let uiImage = UIImage(data: imageData) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 192)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
                ForEach(refImages, id: \.id) { ref in
                    LazyImageView(ref: ref, sessionId: message.sessionId ?? "")
                }
            }
        }
    }

    // MARK: - Helpers

    private func bubbleShape(isUser: Bool) -> UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: isUser ? 16 : 4,
            bottomLeadingRadius: 16,
            bottomTrailingRadius: 16,
            topTrailingRadius: isUser ? 4 : 16
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
        // SwiftUI's `AttributedString(markdown:)` with `.inlineOnly*`
        // does not parse block-level constructs like headings, so a
        // line like "# Title" would render with a literal '#'. Parse
        // headings line-by-line, applying a font run; everything
        // else still goes through inline markdown so bold/italic/
        // links continue to render.
        var result = AttributedString()
        let lines = text.components(separatedBy: "\n")
        for (idx, line) in lines.enumerated() {
            result.append(renderMarkdownLine(line))
            if idx < lines.count - 1 {
                result.append(AttributedString("\n"))
            }
        }
        return result
    }

    private func renderMarkdownLine(_ line: String) -> AttributedString {
        var level = 0
        for ch in line {
            if ch == "#", level < 6 { level += 1 } else { break }
        }
        if level > 0, level < line.count {
            let afterHashes = line.index(line.startIndex, offsetBy: level)
            if line[afterHashes] == " " {
                let content = line[line.index(after: afterHashes)...]
                    .drop(while: { $0 == " " })
                var attr = inlineMarkdown(String(content))
                let font: Font
                switch level {
                case 1: font = .title2.bold()
                case 2: font = .title3.bold()
                case 3: font = .headline
                case 4: font = .subheadline.bold()
                default: font = .footnote.bold()
                }
                attr.font = font
                return attr
            }
        }
        return inlineMarkdown(line)
    }

    private func inlineMarkdown(_ text: String) -> AttributedString {
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
    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var colorScheme

    let message: ChatMessage
    var showPill: Bool = false

    @State private var expanded = false

    private var toolName: String { message.toolName ?? "tool" }
    private var isComplete: Bool { message.type == "tool_complete" }
    /// Best-effort: the per-call success flag from v0.17+ is preferred
    /// over heuristics on the (now lazy) result body.
    private var isError: Bool {
        if let success = message.payload["success"]?.boolValue {
            return !success
        }
        return false
    }

    private var attachmentStore: AttachmentStore { appState.attachmentStore }

    private var isAskUser: Bool {
        toolName == "ask_user" || toolName == "ask"
    }

    private var questionText: String? {
        message.payload["questionText"]?.stringValue
    }

    /// Tinted pill background derived from the session hue so the
    /// tool-name pill picks up the bubble's color. Sits close to the
    /// section's own tint (small lightness delta) so the pill reads
    /// as a soft chip rather than a high-contrast badge.
    private var pillTintColor: Color {
        let hue = stringToHue(message.sessionId ?? toolName) / 360
        let (h, s, b) = hslToHSB(
            h: hue,
            s: colorScheme == .dark ? 0.45 : 0.32,
            l: colorScheme == .dark ? 0.20 : 0.93
        )
        return Color(hue: h, saturation: s, brightness: b)
    }

    /// Slightly contrasting card background for the expanded dialog.
    /// Sits as a near-invisible shade-shift on top of the section's
    /// tint — just enough to read as an inset surface, but designed
    /// to blend with the section rather than stand out. Delta against
    /// the section's lightness is intentionally tiny (~0.01).
    private var expandedDialogBackground: Color {
        let hue = stringToHue(message.sessionId ?? toolName) / 360
        let (h, s, b) = hslToHSB(
            h: hue,
            s: colorScheme == .dark ? 0.40 : 0.30,
            l: colorScheme == .dark ? 0.115 : 0.978
        )
        return Color(hue: h, saturation: s, brightness: b)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isAskUser {
                askUserBody
            } else {
                regularToolBody
            }
        }
        .padding(showPill ? 8 : 0)
        .background(showPill ? AnyShapeStyle(.quaternary.opacity(0.5)) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Ask User (question/answer)

    @ViewBuilder
    private var askUserBody: some View {
        HStack(spacing: 6) {
            if isComplete {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Image(systemName: "questionmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.purple)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(questionText ?? "Question")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.7))

                if isComplete, let result = message.result, !result.isEmpty {
                    Text(result)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)
        }
    }

    // MARK: - Regular Tool

    @ViewBuilder
    private var regularToolBody: some View {
        ToolChipHeader(
            toolName: toolName,
            headline: toolDetail,
            status: chipStatus,
            isExpandable: hasExpandableContent,
            isExpanded: expanded,
            onTap: {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            },
            pillTint: pillTintColor
        )

        if expanded {
            expandedBody
                .onAppear { triggerLazyFetches() }
        }
    }

    private var chipStatus: ToolChipStatus {
        if !isComplete { return .running }
        return isError ? .failure : .success
    }

    /// Tentacle-composed headline preferred; fall back to inline args
    /// for permission-prompt path (still ships args eagerly).
    private var toolDetail: String? {
        if isAskUser { return nil }
        if let h = message.headline, !h.isEmpty { return h }
        if let args = message.args {
            if let cmd = args["command"]?.stringValue { return "$ \(cmd)" }
            if let path = args["path"]?.stringValue { return path }
        }
        return nil
    }

    private var hasExpandableContent: Bool {
        if isAskUser { return message.result != nil }
        return message.argsRef != nil
            || message.resultRef != nil
            || message.args != nil
    }

    private func triggerLazyFetches() {
        guard let sid = message.sessionId else { return }
        if let r = message.argsRef {
            attachmentStore.requestIfNeeded(id: r.id, sessionId: sid)
        }
        if let r = message.resultRef {
            attachmentStore.requestIfNeeded(id: r.id, sessionId: sid)
        }
    }

    @ViewBuilder
    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isAskUser {
                if let result = message.result, !result.isEmpty {
                    Text(result)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } else {
                argsBlock
                resultBlock
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(expandedDialogBackground, in: RoundedRectangle(cornerRadius: 8))
        .padding(.top, 2)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    @ViewBuilder
    private var argsBlock: some View {
        if toolName == "edit" || toolName == "edit_file" {
            if let ref = message.argsRef {
                EditDiffView(ref: ref)
            } else if let inline = message.args, !inline.isEmpty {
                InlineEditDiffView(args: inline)
            }
        } else if let ref = message.argsRef {
            lazyRefBlock(title: "Arguments", ref: ref)
        } else if let args = message.args, !args.isEmpty {
            // Permission-prompt path keeps args inline. Render each key
            // as its own labeled block so command/description/result
            // share a consistent caption-then-monospaced-value style.
            VStack(alignment: .leading, spacing: 8) {
                ForEach(args.sorted { $0.key < $1.key }, id: \.key) { entry in
                    labeledBlock(title: entry.key, content: entry.value.stringValue ?? "\(entry.value)")
                }
            }
        }
    }

    @ViewBuilder
    private var resultBlock: some View {
        if toolName == "edit" {
            // The edit tool's result is just a boilerplate
            // "File … updated with changes." confirmation that's
            // redundant once the diff is shown. Suppress it.
            EmptyView()
        } else if let ref = message.resultRef {
            lazyRefBlock(title: "Result", ref: ref)
        }
    }

    /// Shared label + monospaced-content layout used by `argsBlock`
    /// inline-args and `lazyRefBlock` so the command/description/Result
    /// trio reads with a single visual rhythm.
    @ViewBuilder
    private func labeledBlock(title: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            Text(content)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func lazyRefBlock(title: String, ref: ContentRef) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            switch attachmentStore.state(for: ref.id) {
            case .ready(_, let data):
                ScrollView {
                    Text(String(data: data, encoding: .utf8) ?? "(non-utf8)")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 200)
                // Always show scroll indicators so users have a clear
                // signal when a result is taller than the 200pt cap.
                .scrollIndicators(.visible)
                // Without this, SwiftUI proposes a flexible height to
                // the ScrollView and a sibling tool entry expanding can
                // make the parent VStack reallocate space — the
                // ScrollView then grows up to its 200pt cap regardless
                // of how short its actual content is. `fixedSize` forces
                // the ScrollView to claim its content-driven intrinsic
                // height (capped by the outer `maxHeight: 200` frame).
                .fixedSize(horizontal: false, vertical: true)
            case .error(let reason):
                Text("Couldn't load: \(reason)")
                    .font(.caption2)
                    .foregroundStyle(.red)
            case .awaitingChunks, .fetching, .none:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Loading…")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}

// MARK: - InlineEditDiffView

private struct InlineEditDiffView: View {
    let args: [String: AnyCodable]

    var body: some View {
        let path = args["path"]?.stringValue
        let oldStr = args["old_str"]?.stringValue ?? ""
        let newStr = args["new_str"]?.stringValue ?? ""
        VStack(alignment: .leading, spacing: 2) {
            if let path {
                Text(path)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            DiffBlockView(old: oldStr, new: newStr)
        }
    }
}

// MARK: - DiffBlockView

private struct DiffBlockView: View {
    let old: String
    let new: String

    var body: some View {
        let oldLines = old.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let newLines = new.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(oldLines.enumerated()), id: \.offset) { _, line in
                diffLine(prefix: "-", text: line, color: .red)
            }
            ForEach(Array(newLines.enumerated()), id: \.offset) { _, line in
                diffLine(prefix: "+", text: line, color: .green)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func diffLine(prefix: String, text: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(prefix)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(color)
            Text(text.isEmpty ? " " : text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.primary.opacity(0.85))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 1)
        .background(color.opacity(0.12))
    }
}

// MARK: - EditDiffView

/// Renders the `edit` tool's arguments as a unified diff instead of
/// raw JSON. Loads the args attachment, extracts `old_str` / `new_str`,
/// and renders the change with red `-` lines and green `+` lines.
private struct EditDiffView: View {
    @Environment(AppState.self) private var appState
    let ref: ContentRef

    private var attachmentStore: AttachmentStore { appState.attachmentStore }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch attachmentStore.state(for: ref.id) {
            case .ready(_, let data):
                readyBody(data: data)
            case .error(let reason):
                Text("Couldn't load: \(reason)")
                    .font(.caption2)
                    .foregroundStyle(.red)
            case .awaitingChunks, .fetching, .none:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Loading…")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder
    private func readyBody(data: Data) -> some View {
        if let parsed = parse(data: data) {
            VStack(alignment: .leading, spacing: 2) {
                if let path = parsed.path {
                    Text(path)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                diffBlock(old: parsed.oldStr, new: parsed.newStr)
            }
        } else {
            // Fallback: render the raw JSON if we can't parse it.
            Text(String(data: data, encoding: .utf8) ?? "(non-utf8)")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func diffBlock(old: String, new: String) -> some View {
        DiffBlockView(old: old, new: new)
    }

    private struct EditArgs {
        var path: String?
        var oldStr: String
        var newStr: String
    }

    private func parse(data: Data) -> EditArgs? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let oldStr = (json["old_str"] as? String) ?? (json["oldStr"] as? String)
        let newStr = (json["new_str"] as? String) ?? (json["newStr"] as? String)
        guard let oldStr, let newStr else { return nil }
        return EditArgs(
            path: json["path"] as? String,
            oldStr: oldStr,
            newStr: newStr
        )
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

private struct QuestionLineView: View {
    let message: ChatMessage

    private var questionText: String {
        message.payload["question"]?.stringValue ?? message.question ?? "Question"
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.purple)
            Text(questionText)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.primary.opacity(0.7))
                .lineLimit(2)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - PermissionLineView

/// Compact, inline rendering of a permission ask used inside an agent
/// bubble's bottom activity section. Shape matches QuestionLineView /
/// ToolLineView so the row sits cleanly alongside other tool calls.
/// The same view handles every state — pending and resolved — by
/// swapping only the leading icon's color/glyph and the trailing status
/// pill, so a resolve never produces a separate bubble.
private struct PermissionLineView: View {
    let message: ChatMessage

    private var toolName: String { message.toolName ?? "tool" }
    private var resolution: String? { message.resolution }

    private var detail: String {
        if let desc = message.toolDescription,
           !desc.isEmpty, desc != "Run:", desc != "Run: " {
            return desc
        }
        guard let args = message.args else { return "" }
        if (toolName == "shell" || toolName == "bash"),
           let cmd = args["command"]?.stringValue, !cmd.isEmpty {
            return "$ \(cmd)"
        }
        if let cmd = args["command"]?.stringValue, !cmd.isEmpty { return "$ \(cmd)" }
        if let path = args["path"]?.stringValue, !path.isEmpty { return path }
        return ""
    }

    private var icon: String {
        switch resolution {
        case "approved":        return "checkmark.circle.fill"
        case "always_allowed":  return "lock.open.fill"
        case "denied":          return "xmark.circle.fill"
        case "cancelled":       return "stop.circle.fill"
        default:                return "lock.fill"
        }
    }

    private var iconColor: Color {
        switch resolution {
        case "approved", "always_allowed": return .green
        case "denied":                     return .red
        case "cancelled":                  return .secondary
        default:                           return .orange
        }
    }

    private var statusBadge: String? {
        switch resolution {
        case "approved":        return "Approved"
        case "always_allowed":  return "Allowed"
        case "denied":          return "Denied"
        case "cancelled":       return "Cancelled"
        default:                return nil
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(iconColor)

            Text(toolName)
                .font(.system(size: 12, design: .monospaced))
                .fontWeight(.medium)
                .foregroundStyle(.blue)

            if !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 0)

            if let statusBadge {
                Text(statusBadge)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(iconColor)
            }
        }
        .contentShape(Rectangle())
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

// MARK: - TypingDotsView

private struct TypingDotsView: View {
    @State private var phase: Int = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(.primary.opacity(0.5))
                    .frame(width: 6, height: 6)
                    .scaleEffect(phase == i ? 1.3 : 0.8)
                    .opacity(phase == i ? 1.0 : 0.5)
            }
        }
        .frame(height: 18, alignment: .leading)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: false)) {
                // Drive a TimelineView-free pulse via a Timer-style animation
            }
            startCycle()
        }
    }

    private func startCycle() {
        Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 350_000_000)
                withAnimation(.easeInOut(duration: 0.3)) {
                    phase = (phase + 1) % 3
                }
            }
        }
    }
}

#endif
