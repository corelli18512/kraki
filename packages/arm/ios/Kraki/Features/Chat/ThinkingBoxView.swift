#if os(iOS)
/// ThinkingBoxView — Collapsed thinking indicator + full-screen modal, mirroring ThinkingBox.tsx.
///
/// Shows a compact status row (dot + summary) in the chat. Tapping opens a
/// full-screen modal with all thinking messages and tool activities.

import SwiftUI

struct ThinkingBoxView: View {
    let messages: [ChatMessage]
    let isActive: Bool
    var agent: String = ""
    var streamingText: String?

    @State private var showModal = false

    /// Skip 'active' messages — they're structural, not displayable.
    private var visibleMessages: [ChatMessage] {
        messages.filter { $0.type != "active" }
    }

    private var summary: String {
        if let streaming = streamingText, !streaming.isEmpty {
            return streaming.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let last = visibleMessages.last else { return "Processing…" }
        return messageSummary(last)
    }

    var body: some View {
        if visibleMessages.isEmpty && streamingText == nil {
            EmptyView()
        } else {
            Button { showModal = true } label: {
                HStack(alignment: .top, spacing: 8) {
                    statusDot
                        .padding(.top, 5)

                    Text(markdownSummary(summary))
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                        .lineLimit(isActive ? nil : 3)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.top, 4)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fullScreenCover(isPresented: $showModal) {
                ThinkingModalView(
                    messages: messages,
                    agent: agent,
                    streamingText: streamingText
                )
            }
        }
    }

    // MARK: - Status Dot

    private var statusDot: some View {
        Circle()
            .fill(isActive ? Color.blue : Color.green)
            .frame(width: 8, height: 8)
            .modifier(PulseModifier(active: isActive))
    }

    // MARK: - Summary Helpers

    private func messageSummary(_ msg: ChatMessage) -> String {
        switch msg.type {
        case "tool_start", "tool_complete":
            let toolName = msg.toolName ?? ""
            let detail = toolDetail(msg.args)
            if !toolName.isEmpty {
                return detail.isEmpty ? toolName : "\(toolName) \(detail)"
            }
            return detail.isEmpty ? (msg.type == "tool_start" ? "Running…" : "Done") : detail

        case "agent_message":
            let content = msg.content ?? ""
            return content.isEmpty ? "Agent thinking…" : content.trimmingCharacters(in: .whitespacesAndNewlines)

        case "permission":
            return "Permission: \(msg.toolName ?? "tool")"

        case "error":
            return "Error: \(msg.errorMessage ?? "")"

        case "idle":
            return "Waiting…"

        case "session_mode_set":
            return "Mode: \(msg.mode ?? "updated")"

        default:
            return "Processing…"
        }
    }

    private func toolDetail(_ args: [String: AnyCodable]?) -> String {
        guard let args else { return "" }
        if let cmd = args["command"]?.stringValue { return "$ \(cmd)" }
        if let path = args["path"]?.stringValue { return path }
        if let pattern = args["pattern"]?.stringValue { return pattern }
        if let url = args["url"]?.stringValue { return url }
        return ""
    }

    private func markdownSummary(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(text)
    }
}

// MARK: - Pulse Modifier

private struct PulseModifier: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content
                .symbolEffect(.pulse, isActive: true)
                .shadow(color: .blue.opacity(0.5), radius: 4)
        } else {
            content
        }
    }
}

// MARK: - ThinkingModalView

struct ThinkingModalView: View {
    let messages: [ChatMessage]
    var agent: String = ""
    var streamingText: String?

    @Environment(\.dismiss) private var dismiss
    @State private var allExpanded = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(messages.enumerated()), id: \.offset) { idx, msg in
                            if msg.type != "active" {
                                thinkingItem(msg, index: idx)
                            }
                        }

                        // Streaming text with blinking cursor
                        if let streaming = streamingText, !streaming.isEmpty {
                            HStack(alignment: .bottom, spacing: 2) {
                                Text(markdownContent(streaming))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Rectangle()
                                    .fill(.secondary)
                                    .frame(width: 2, height: 14)
                                    .modifier(PulseModifier(active: true))
                            }
                            .id("streaming-cursor")
                        }

                        // Anchor for scrolling
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                    }
                    .padding()
                }
                .onAppear {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                .onChange(of: messages.count) {
                    withAnimation {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
            .navigationTitle("Steps")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(allExpanded ? "Collapse All" : "Expand All") {
                        allExpanded.toggle()
                    }
                    .font(.caption)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    @ViewBuilder
    private func thinkingItem(_ msg: ChatMessage, index: Int) -> some View {
        switch msg.type {
        case "agent_message":
            if let content = msg.content {
                Text(markdownContent(content))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

        case "tool_start":
            ToolActivityView(
                type: .start,
                toolName: msg.toolName ?? "tool",
                args: msg.args,
                result: nil,
                forceExpanded: allExpanded
            )

        case "tool_complete":
            ToolActivityView(
                type: .complete,
                toolName: msg.toolName ?? "tool",
                args: msg.args,
                result: msg.result,
                forceExpanded: allExpanded
            )

        default:
            MessageBubbleView(message: msg, agent: agent)
        }
    }

    private func markdownContent(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(text)
    }
}

#endif
