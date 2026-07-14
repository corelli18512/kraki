#if os(iOS)
/// MessageBubbleView — Renders individual chat messages, mirroring MessageBubble.tsx.
///
/// Dispatches on message type to produce the correct bubble style:
/// user messages right-aligned in blue, agent messages left-aligned with avatar,
/// system events centered, errors in red cards, etc.

import SwiftUI

/// Module-level cache for parsed markdown `AttributedString` values.
///
/// **Why this exists.** Foundation's `AttributedString(markdown:)` parser
/// is a couple of orders of magnitude slower than the rest of the
/// SwiftUI text path on real iPhones. Without caching, every layout
/// pass through `MessageBubbleView.body` re-parses the same finalised
/// message content from scratch. On a long agent reply (a 20 KB log
/// dump or a code paste) that's tens of milliseconds per render, and
/// SwiftUI re-renders the bubble many times as the scroll view
/// negotiates content height — symptom: tapping into a session with
/// any long message immediately spikes CPU to 100 %.
///
/// Finalised message content never changes, so we parse once on
/// first observation and serve a stored `NSAttributedString` (the
/// reference-typed counterpart that `NSCache` can hold) on every
/// re-render after that. `NSCache` auto-purges under memory pressure
/// — no manual eviction needed.
///
/// Keyed by a stable string composed of the message id + content
/// length + a Swift `String.hash`. The hash collapses unique content
/// even when message ids collide (e.g., the synthetic streaming-turn
/// placeholder reuses ids across turns).
private let markdownCache: NSCache<NSString, NSAttributedString> = {
    let cache = NSCache<NSString, NSAttributedString>()
    cache.name = "kraki.MarkdownCache"
    cache.countLimit = 512
    return cache
}()

/// Returns parsed markdown for `text` keyed under `cacheKey`. First
/// call parses; subsequent calls are O(1) dict lookups. See the doc on
/// `markdownCache` for the rationale.
private func cachedMarkdown(text: String, cacheKey: String) -> AttributedString {
    let key = cacheKey as NSString
    if let cached = markdownCache.object(forKey: key) {
        return AttributedString(cached)
    }
    let parsed = parseMarkdownOnce(text)
    markdownCache.setObject(NSAttributedString(parsed), forKey: key)
    return parsed
}

/// Single-shot markdown parse over the whole text.
///
/// The previous implementation split by newline and invoked
/// `AttributedString(markdown:)` once per line in order to support
/// ATX headings (Foundation's inline-only mode doesn't recognise
/// `# Heading` as a block construct). For long messages this meant
/// hundreds of parser invocations per call. The parser has a
/// non-trivial setup cost per invocation, so the line-by-line loop
/// dwarfs the actual text content in CPU time.
///
/// New strategy: hand the whole text to the parser ONCE with
/// `.inlineOnlyPreservingWhitespace` (which keeps newlines intact),
/// then run a single linear post-pass over the original `text` to
/// find lines that start with `^#{1,6} ` and upgrade their
/// `AttributedString` ranges to the corresponding heading font.
/// One parser invocation + O(text) post-pass instead of O(lines)
/// parser invocations.
private func parseMarkdownOnce(_ text: String) -> AttributedString {
    var result: AttributedString = (try? AttributedString(
        markdown: text,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(text)

    // Heading post-pass. Walk the original text line-by-line so we
    // can map a line's UTF-16 offset range back into the parsed
    // `AttributedString` and overwrite the font on that span. Cheap
    // — purely byte arithmetic, no extra parser invocations.
    var cursor = text.startIndex
    while cursor < text.endIndex {
        let lineEnd = text[cursor...].firstIndex(of: "\n") ?? text.endIndex
        let line = text[cursor..<lineEnd]
        if let font = headingFont(for: line) {
            // Find the parsed range that corresponds to this slice
            // of the original text. The inline-only parser preserves
            // text length 1:1 with the source (except for inline
            // markers like `**…**` which are removed). To stay
            // robust we locate the heading by the literal substring
            // it contains after stripping the leading `#`s — that
            // substring survives parsing unchanged.
            let stripped = line.drop(while: { $0 == "#" }).drop(while: { $0 == " " })
            if !stripped.isEmpty,
               let range = result.range(of: String(stripped)) {
                result[range].font = font
            }
        }
        if lineEnd == text.endIndex { break }
        cursor = text.index(after: lineEnd)
    }
    return result
}

/// Maps an ATX heading line to the SwiftUI font to apply, or nil if
/// the line isn't a heading.
private func headingFont(for line: Substring) -> Font? {
    var level = 0
    for ch in line {
        if ch == "#", level < 6 { level += 1 } else { break }
    }
    guard level > 0 else { return nil }
    let afterHashes = line.index(line.startIndex, offsetBy: level)
    guard afterHashes < line.endIndex, line[afterHashes] == " " else { return nil }
    switch level {
    case 1: return .title2.bold()
    case 2: return .title3.bold()
    case 3: return .headline
    case 4: return .subheadline.bold()
    default: return .footnote.bold()
    }
}

struct MessageBubbleView: View {
    let message: ChatMessage
    /// Active session id used as the stable seed for hue derivation.
    /// Forwarded by the container view so that synthetic messages
    /// (streaming agent_message with sessionId=nil, fallback synthetics)
    /// still pick up the surrounding session's color rather than
    /// falling back to the agent name. Defaults to "" so unrelated
    /// previews/callers still compile; the legacy
    /// `message.sessionId ?? agent` fallback remains as a safety net.
    var sessionId: String = ""
    var agent: String = ""
    var turnImages: [ImageAttachment]?
    var thinkingHistory: [ChatMessage] = []
    @Binding var historyExpanded: Bool
    var streamingText: String?
    @State private var solidCharCount: Int = 0
    @State private var batchTimestamp: Date = .distantPast

    @Environment(\.colorScheme) private var colorScheme

    // MARK: - Computed Properties

    /// Single pass through `thinkingHistory` that classifies entries
    /// into pre-message / post-message buckets. Repeated calls to
    /// `preMessageHistory` / `postMessageActivity` (which happen
    /// across many view-body computations on tool-heavy turns) all
    /// reuse the same single filter pass instead of re-iterating
    /// the full history three times per render.
    private var historySplit: (pre: [ChatMessage], post: [ChatMessage]) {
        var pre: [ChatMessage] = []
        var post: [ChatMessage] = []
        pre.reserveCapacity(thinkingHistory.count)
        post.reserveCapacity(thinkingHistory.count)
        for item in thinkingHistory {
            if item.type == "active" { continue }
            if item.seq <= message.seq {
                pre.append(item)
            } else {
                post.append(item)
            }
        }
        return (pre, post)
    }

    /// Items before the final message (top history section)
    private var preMessageHistory: [ChatMessage] { historySplit.pre }

    /// Items after the final message (bottom tool section)
    private var postMessageActivity: [ChatMessage] {
        guard streamingText == nil || streamingText?.isEmpty == true else { return [] }
        return historySplit.post
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

    /// Stable seed for all per-bubble hue derivation. Prefers the
    /// injected `sessionId` (provided by the container that knows the
    /// active session); only falls back to the legacy
    /// `message.sessionId ?? agent` chain when no seed was injected
    /// (so older callers / previews still get *some* color).
    private var hueSeed: String {
        sessionId.isEmpty ? (message.sessionId ?? agent) : sessionId
    }

    private var agentBubbleColor: Color {
        let hue = stringToHue(hueSeed) / 360
        let (h, s, b) = hslToHSB(
            h: hue,
            s: colorScheme == .dark ? 0.35 : 0.40,
            l: colorScheme == .dark ? 0.18 : 0.93
        )
        return Color(hue: h, saturation: s, brightness: b)
    }

    private var sectionTintColor: Color {
        let hue = stringToHue(hueSeed) / 360
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
        let hue = stringToHue(hueSeed) / 360
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
                content: message.payload["content"]?.stringValue ?? message.payload["text"]?.stringValue,
                attachments: message.attachments,
                timestamp: message.timestamp
            )

        case "pending_input":
            pendingInputBubble

        case "agent_message":
            agentBubble

        case "turn_status", "interrupted_turn":
            // Legacy interrupted_turn is normalized at the render boundary and
            // uses the same terminal status bubble. It has no separate UI.
            turnStatusBubble

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

    // MARK: - Terminal Turn Status

    private var turnStatusBubble: some View {
        let action = message.terminalAction
        let legacyProcessLost = message.type == "interrupted_turn" && message.reason == "process_lost"
        let failed = legacyProcessLost || action?["type"]?.stringValue == "failed"
        let label = failed ? "Turn failed" : "User aborted"
        let icon = failed ? "xmark.octagon.fill" : "stop.circle.fill"
        let tint: Color = failed ? .red : .secondary
        let detail = legacyProcessLost
            ? "Agent process was lost"
            : (failed ? action?["payload"]?.dictValue?["message"]?.stringValue : nil)
        return HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
                if let draft = message.interruptedDraft, !draft.isEmpty {
                    messageBody(draft, foreground: .primary.opacity(0.8))
                }
                imageGrid(attachments: message.attachments)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Label(label, systemImage: icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.secondary.opacity(0.08), in: bubbleShape(isUser: false))
            Spacer(minLength: WindowSize.width * 0.05)
        }
    }

    // MARK: - User Bubble

    @ViewBuilder
    private func userBubble(content: String?, attachments: [ImageAttachment]?, timestamp: String?) -> some View {
        let showText = content != nil && content != "[image]"
        return HStack {
            Spacer(minLength: WindowSize.width * 0.10)
            VStack(alignment: .trailing, spacing: 4) {
                if showText, let content {
                    // User messages go through the same cached
                    // markdown path as agent replies. The cache
                    // (see `cachedMarkdown` at file top) makes
                    // long user-pasted content cheap on re-renders
                    // — first observation parses once, every render
                    // after that is a dict lookup.
                    messageBody(content, foreground: .white)
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
        // CommandSender writes the text to `payload.content` (matches
        // the eventual `user_message` shape). Earlier code wrote to
        // `payload.text` which mismatched and caused the pending
        // bubble to render blank. Keep a fallback to `text` for any
        // stale-in-memory placeholders.
        let text = message.payload["content"]?.stringValue ?? message.payload["text"]?.stringValue
        let showText = text != nil && text != "[image]"
        return HStack {
            Spacer(minLength: WindowSize.width * 0.10)
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
                        } else if let last = postMessageActivity.last {
                            historyItemView(last)
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
            Spacer(minLength: WindowSize.width * 0.05)
        }
    }

    // MARK: - Message Content

    @ViewBuilder
    private var messageContent: some View {
        if let streaming = streamingText, !streaming.isEmpty {
            streamingTextView(streaming)
        } else if let content = message.content, !content.isEmpty {
            messageBody(content, foreground: .primary)
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
                messageBody(content, foreground: .primary.opacity(0.7))
            }
        case "tool_start", "tool_complete":
            ToolLineView(message: item, sessionId: sessionId)
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
        // Plain Text — NO markdown, NO TimelineView, NO per-token
        // attributed-string rebuild.
        //
        // The previous implementation wrapped the streaming view in a
        // `TimelineView(.animation)` block that rebuilt an
        // `AttributedString` of every token in the growing text on
        // every animation frame (60–120 Hz) to drive a per-character
        // fade-in. That's O(text) per tick × 60 ticks/sec × growing
        // text length × however often new deltas arrive — by the end
        // of a long agent reply it dominated the main thread.
        //
        // While streaming we now render the running text as a plain
        // string. When the turn finalises, `messageContent` swaps to
        // `messageBody(content, …)` which goes through the cached
        // markdown path and gets proper formatting. The brief moment
        // between "last delta" and "idle" where the bubble shows
        // plain text is imperceptible and is well worth the dramatic
        // CPU savings on long streams.
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.primary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Agent Avatar

    private var agentAvatar: some View {
        AgentAvatar(agent: agent,
                    sessionId: sessionId.isEmpty ? message.sessionId : sessionId,
                    size: .sm)
    }

    // MARK: - Session Created

    private var sessionCreatedBanner: some View {
        let agentName = message.payload["agent"]?.stringValue ?? "Agent"
        let forked = message.payload["forked"]?.boolValue == true || message.seq > 1
        let model = message.payload["model"]?.stringValue
        return HStack(spacing: 4) {
            Spacer()
            AgentAvatar(agent: agentName,
                        sessionId: sessionId.isEmpty ? message.sessionId : sessionId,
                        size: .xs)
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

    @ViewBuilder
    private var answerBubble: some View {
        // Skip rendering entirely if the answer payload is missing or
        // empty — otherwise we'd show a hollow accent-colored bubble.
        if let answer = message.answer, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            HStack {
                Spacer(minLength: WindowSize.width * 0.15)
                VStack(alignment: .trailing, spacing: 4) {
                    Text("Answer")
                        .font(.system(size: 10))
                        .fontWeight(.medium)
                        .foregroundStyle(.white.opacity(0.7))
                    Text(answer)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.accentColor.opacity(0.85), in: bubbleShape(isUser: true))
            }
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
            Spacer(minLength: WindowSize.width * 0.15)
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
                Spacer(minLength: WindowSize.width * 0.15)
            }

            // Answer (if provided)
            if let answer = message.answer {
                HStack {
                    Spacer(minLength: WindowSize.width * 0.15)
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

    /// Renders message content with code-block awareness. Splits the text
    /// into inline segments and fenced ``` code blocks; inline segments go
    /// through the cached single-shot markdown parser (see
    /// `cachedMarkdown` / `parseMarkdownOnce`), code blocks render as a
    /// styled horizontally-scrollable monospace box.
    @ViewBuilder
    private func messageBody(_ text: String, foreground: Color) -> some View {
        let segments = splitMessageBody(text)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(segments.indices, id: \.self) { i in
                switch segments[i] {
                case .inline(let content):
                    Text(cachedMarkdown(text: content, cacheKey: cacheKey(for: content, suffix: "i\(i)")))
                        .font(.subheadline)
                        .foregroundStyle(foreground)
                        .textSelection(.enabled)
                case .blockquote(let content):
                    HStack(alignment: .top, spacing: 8) {
                        Rectangle()
                            .fill(foreground.opacity(0.4))
                            .frame(width: 3)
                        Text(cachedMarkdown(text: content, cacheKey: cacheKey(for: content, suffix: "q\(i)")))
                            .font(.subheadline)
                            .foregroundStyle(foreground.opacity(0.85))
                            .textSelection(.enabled)
                            .padding(.vertical, 2)
                    }
                    .padding(.leading, 4)
                case .codeBlock(let language, let code):
                    VStack(alignment: .leading, spacing: 0) {
                        if let language, !language.isEmpty {
                            Text(language)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 10)
                                .padding(.top, 6)
                                .padding(.bottom, 2)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(code)
                                .font(.system(size: 13, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(.horizontal, 10)
                                .padding(.vertical, language == nil ? 8 : 4)
                                .padding(.bottom, 8)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                case .table(let rows, let alignments):
                    tableView(rows: rows, alignments: alignments, foreground: foreground, segmentIndex: i)
                }
            }
        }
    }

    /// Build a stable cache key for a content segment. Combines the
    /// message id (so two messages with identical text don't collide
    /// across distinct identities), a position suffix (so multiple
    /// segments of the same message stay distinct), the content
    /// length, and the Swift hash of the content. Pure value-typed
    /// inputs — safe to compute on every render; cheap.
    private func cacheKey(for content: String, suffix: String) -> String {
        "\(message.id):\(suffix):\(content.count):\(content.hashValue)"
    }

    /// Renders a GFM table. Wraps the table in a horizontal ScrollView
    /// so wide tables don't blow out the bubble; the table itself uses
    /// a Grid (iOS 16+) for clean column alignment without per-cell
    /// width math. Each cell's text goes through the cached markdown
    /// path so inline formatting (bold, italic, links) keeps working.
    @ViewBuilder
    private func tableView(rows: [[String]], alignments: [TableAlignment], foreground: Color, segmentIndex: Int) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r].indices, id: \.self) { c in
                            let cell = rows[r][c]
                            let alignment = c < alignments.count ? alignments[c] : .leading
                            Text(cachedMarkdown(
                                text: cell,
                                cacheKey: cacheKey(for: cell, suffix: "t\(segmentIndex)r\(r)c\(c)")
                            ))
                            .font(.subheadline)
                            .fontWeight(r == 0 ? .semibold : .regular)
                            .foregroundStyle(foreground)
                            .multilineTextAlignment(textAlignment(for: alignment))
                            .frame(maxWidth: .infinity, alignment: frameAlignment(for: alignment))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                // Header gets a subtle tint to set it
                                // apart from body rows.
                                r == 0 ? foreground.opacity(0.08) : Color.clear
                            )
                            .overlay(
                                Rectangle()
                                    .stroke(foreground.opacity(0.15), lineWidth: 0.5)
                            )
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func textAlignment(for alignment: TableAlignment) -> TextAlignment {
        switch alignment {
        case .leading:  return .leading
        case .center:   return .center
        case .trailing: return .trailing
        }
    }

    private func frameAlignment(for alignment: TableAlignment) -> Alignment {
        switch alignment {
        case .leading:  return .leading
        case .center:   return .center
        case .trailing: return .trailing
        }
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
    /// Active session id used as the stable seed for hue derivation
    /// (mirrors `MessageBubbleView.sessionId`). Forwarded by the
    /// container so synthetic tool entries always pick up the
    /// surrounding session's color rather than the tool name.
    var sessionId: String = ""
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
        let seed = sessionId.isEmpty ? (message.sessionId ?? toolName) : sessionId
        let hue = stringToHue(seed) / 360
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
        let seed = sessionId.isEmpty ? (message.sessionId ?? toolName) : sessionId
        let hue = stringToHue(seed) / 360
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

    @State private var expanded = false

    private static let collapsedLinesPerSide = 60

    var body: some View {
        let oldLines = old.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let newLines = new.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let limit = expanded ? Int.max : Self.collapsedLinesPerSide
        let oldVisible = Array(oldLines.prefix(limit))
        let newVisible = Array(newLines.prefix(limit))
        let oldHidden = max(0, oldLines.count - oldVisible.count)
        let newHidden = max(0, newLines.count - newVisible.count)

        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(oldVisible.enumerated()), id: \.offset) { _, line in
                diffLine(prefix: "-", text: line, color: .red)
            }
            ForEach(Array(newVisible.enumerated()), id: \.offset) { _, line in
                diffLine(prefix: "+", text: line, color: .green)
            }
            if oldHidden > 0 || newHidden > 0 {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    Text(expandLabel(oldHidden: oldHidden, newHidden: newHidden))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                        .background(Color.secondary.opacity(0.08))
                }
                .buttonStyle(.plain)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func expandLabel(oldHidden: Int, newHidden: Int) -> String {
        if expanded { return "  Collapse" }
        var pieces: [String] = []
        if oldHidden > 0 { pieces.append("\(oldHidden) removed") }
        if newHidden > 0 { pieces.append("\(newHidden) added") }
        return "  \(pieces.joined(separator: ", ")) — tap to expand"
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

// MARK: - Message body splitter

private enum MessageBodySegment {
    case inline(String)
    case blockquote(String)
    case codeBlock(language: String?, code: String)
    /// GitHub-Flavored Markdown table. `rows[0]` is the header row;
    /// alignments are per-column (length matches `rows[0].count`).
    /// Stored already-parsed because the table spans multiple lines
    /// and the splitter has the cleanest view of the syntax — no
    /// reason to re-tokenise it downstream.
    case table(rows: [[String]], alignments: [TableAlignment])
}

enum TableAlignment {
    case leading, center, trailing
}

/// Splits a message body into inline text, blockquote, fenced
/// code-block, and GFM table segments. Blockquote lines start with
/// `> `. Code blocks are fenced with triple backticks. Tables follow
/// the GFM shape: a header row (`| a | b |`), a separator row
/// (`| --- | :-: |`) with optional `:` alignment markers, and one or
/// more body rows. Anything that doesn't match falls through to
/// inline markdown.
private func splitMessageBody(_ text: String) -> [MessageBodySegment] {
    var segments: [MessageBodySegment] = []
    var inlineBuffer: [String] = []
    var quoteBuffer: [String] = []
    var codeBuffer: [String] = []
    var codeLanguage: String?
    var inCodeBlock = false

    func flushInline() {
        if !inlineBuffer.isEmpty {
            segments.append(.inline(inlineBuffer.joined(separator: "\n")))
            inlineBuffer.removeAll()
        }
    }
    func flushQuote() {
        if !quoteBuffer.isEmpty {
            segments.append(.blockquote(quoteBuffer.joined(separator: "\n")))
            quoteBuffer.removeAll()
        }
    }

    let lines = text.components(separatedBy: "\n")
    var i = 0
    while i < lines.count {
        let line = lines[i]

        if inCodeBlock {
            if line.hasPrefix("```") {
                segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
                codeBuffer.removeAll()
                codeLanguage = nil
                inCodeBlock = false
            } else {
                codeBuffer.append(line)
            }
            i += 1
            continue
        }

        if line.hasPrefix("```") {
            flushInline()
            flushQuote()
            let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            codeLanguage = lang.isEmpty ? nil : lang
            inCodeBlock = true
            i += 1
            continue
        }

        // Table probe: current line looks like a table row AND the
        // next line is a valid separator. Both checks are cheap;
        // most messages won't have any pipes at all and short-circuit
        // immediately.
        if looksLikeTableRow(line),
           i + 1 < lines.count,
           let alignments = parseTableSeparator(lines[i + 1]) {
            let header = parseTableRow(line)
            // Header column count must match the separator column count.
            if header.count == alignments.count {
                flushInline()
                flushQuote()
                var rows: [[String]] = [header]
                var j = i + 2
                while j < lines.count {
                    let r = lines[j]
                    if !looksLikeTableRow(r) { break }
                    let row = parseTableRow(r)
                    // Pad/truncate so every row has the same column
                    // count — GFM-compatible.
                    var padded = row
                    if padded.count < alignments.count {
                        padded += Array(repeating: "", count: alignments.count - padded.count)
                    } else if padded.count > alignments.count {
                        padded = Array(padded.prefix(alignments.count))
                    }
                    rows.append(padded)
                    j += 1
                }
                segments.append(.table(rows: rows, alignments: alignments))
                i = j
                continue
            }
        }

        // Blockquote: line starts with "> " or is exactly ">".
        if line.hasPrefix("> ") || line == ">" {
            flushInline()
            let content = line == ">" ? "" : String(line.dropFirst(2))
            quoteBuffer.append(content)
            i += 1
            continue
        }

        // Empty line between quote lines ends the quote group.
        if line.isEmpty, !quoteBuffer.isEmpty {
            flushQuote()
            inlineBuffer.append(line)
            i += 1
            continue
        }

        flushQuote()
        inlineBuffer.append(line)
        i += 1
    }

    if inCodeBlock {
        segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
    }
    flushQuote()
    flushInline()

    return segments
}

// MARK: - GFM table helpers

/// Cheap "could this be a table row?" check. Triggers on any line
/// that contains at least one pipe AND isn't an obvious non-table
/// (fenced code, blockquote). Real validation happens via
/// `parseTableSeparator` on the next line; this is just a fast gate
/// so non-table messages skip the more expensive checks.
private func looksLikeTableRow(_ line: String) -> Bool {
    guard line.contains("|") else { return false }
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("```") || trimmed.hasPrefix("> ") || trimmed == ">" {
        return false
    }
    return true
}

/// Parses a separator row like `| :--- | :-: | ---: |` into per-
/// column alignments. Returns nil if the line isn't a valid GFM
/// separator (any cell that doesn't match `:?-+:?`).
private func parseTableSeparator(_ line: String) -> [TableAlignment]? {
    let cells = parseTableRow(line)
    guard !cells.isEmpty else { return nil }
    var alignments: [TableAlignment] = []
    for cell in cells {
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        let hasLeftColon = trimmed.hasPrefix(":")
        let hasRightColon = trimmed.hasSuffix(":")
        // Strip leading/trailing colons before verifying the dashes.
        var dashes = trimmed
        if hasLeftColon { dashes.removeFirst() }
        if hasRightColon { dashes.removeLast() }
        guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
        switch (hasLeftColon, hasRightColon) {
        case (true, true):  alignments.append(.center)
        case (false, true): alignments.append(.trailing)
        default:            alignments.append(.leading)
        }
    }
    return alignments
}

/// Splits one table row into trimmed cells. Strips the optional
/// leading/trailing pipe wrappers GFM allows.
private func parseTableRow(_ line: String) -> [String] {
    var s = Substring(line)
    if s.first == "|" { s = s.dropFirst() }
    if s.last == "|" { s = s.dropLast() }
    return s.split(separator: "|", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
}

#endif
