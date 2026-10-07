import SwiftUI

/// A step that dispatched a subagent: one card in Steps that opens the
/// subagent's own page (iOS and Mac alike).
struct SubagentCardRow: View {
    let message: ChatMessage
    let merged: [ChatMessage]
    let onOpen: (String) -> Void

    var body: some View {
        let info = SubagentSteps.info(of: message)
        let meta = SubagentSteps.cardMeta(merged, message)
        Button {
            if let id = message.toolCallId { onOpen(id) }
        } label: {
            HStack(spacing: 10) {
                SubagentStatusIcon(status: SubagentSteps.status(of: message))
                VStack(alignment: .leading, spacing: 2) {
                    Text(info?.name ?? message.toolName ?? "subagent")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.textTitle)
                        .lineLimit(1)
                    if let task = info?.task, !task.isEmpty {
                        Text(task)
                            .font(.footnote)
                            .foregroundStyle(Color.textSecondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if !meta.isEmpty {
                    Text(meta)
                        .font(.caption)
                        .foregroundStyle(Color.textMuted)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.textMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.borderPrimary, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open subagent \(info?.name ?? "")")
        .accessibilityIdentifier("subagent-card")
    }
}

struct SubagentStatusIcon: View {
    let status: SubagentInfo.Status

    var body: some View {
        Group {
            switch status {
            case .running:
                ProgressView().controlSize(.small)
            case .completed:
                Image(systemName: "checkmark.circle").foregroundStyle(.green)
            case .failed:
                Image(systemName: "xmark.circle").foregroundStyle(.red)
            case .stopped:
                Image(systemName: "stop.circle").foregroundStyle(.orange)
            }
        }
        .font(.body)
        .frame(width: 18, height: 18)
    }
}

/// One subagent: what it was asked, its own steps (nested subagents as cards),
/// and what it reported back.
struct SubagentPageView<StepView: View>: View {
    let sessionId: String
    let dispatchId: String
    let merged: [ChatMessage]
    let onOpen: (String) -> Void
    @ViewBuilder let stepView: (ChatMessage) -> StepView

    @Environment(AppState.self) private var appState

    private var dispatch: ChatMessage? { merged.first { $0.toolCallId == dispatchId } }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let dispatch {
                    header(dispatch)
                    let steps = SubagentSteps.steps(merged, under: dispatchId)
                    if steps.isEmpty {
                        Text(SubagentSteps.status(of: dispatch) == .running
                             ? "Working… its steps appear here as it reports them."
                             : "The agent did not report this subagent's steps.")
                            .font(.footnote)
                            .foregroundStyle(Color.textSecondary)
                    }
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                        if SubagentSteps.isSubagentStep(merged, step) {
                            SubagentCardRow(message: step, merged: merged, onOpen: onOpen)
                        } else {
                            stepView(step)
                        }
                    }
                    if SubagentSteps.status(of: dispatch) != .running,
                       dispatch.type == "tool_complete",
                       let ref = dispatch.resultRef {
                        report(ref)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private func header(_ m: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let task = SubagentSteps.info(of: m)?.task, !task.isEmpty {
                Text(task)
                    .font(.subheadline)
                    .foregroundStyle(Color.textTitle)
                    .textSelection(.enabled)
            }
            Text(SubagentSteps.pageFacts(merged, m))
                .font(.caption)
                .foregroundStyle(Color.textMuted)
        }
        .padding(.bottom, 4)
    }

    /// Light markdown for a report: inline styles per line, list items as
    /// bullets, headings bold (matching the bubble action slot's approach).
    static func reportText(_ text: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var out = AttributedString()
        let lines = text.components(separatedBy: "\n")
        for (i, raw) in lines.enumerated() {
            var line = raw
            var heading = false
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let hashes = trimmed.firstIndex(where: { $0 != "#" }), trimmed.hasPrefix("#"), trimmed[hashes] == " " {
                line = String(trimmed[hashes...]).trimmingCharacters(in: .whitespaces)
                heading = true
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                let indent = String(line.prefix(while: { $0 == " " }))
                line = indent + "• " + trimmed.dropFirst(2)
            }
            var part = (try? AttributedString(markdown: line, options: opts)) ?? AttributedString(line)
            if heading { part.font = .subheadline.weight(.semibold) }
            out += part
            if i < lines.count - 1 { out += AttributedString("\n") }
        }
        return out
    }

    @ViewBuilder
    private func report(_ ref: ContentRef) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            Text("REPORT")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.textSecondary)
            switch appState.attachmentStore.state(for: ref.id) {
            case .ready(_, let data):
                Text(Self.reportText(String(data: data, encoding: .utf8) ?? ""))
                    .font(.subheadline)
                    .foregroundStyle(Color.textTitle)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .error(let reason):
                Text("Couldn't load: \(reason)").font(.caption).foregroundStyle(.red)
            default:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Loading…").font(.caption).foregroundStyle(Color.textMuted)
                }
            }
        }
        .accessibilityIdentifier("subagent-report")
        .onAppear {
            appState.attachmentStore.requestIfNeeded(id: ref.id, sessionId: sessionId, priority: .userOpened)
        }
        .onDisappear {
            appState.attachmentStore.release(id: ref.id, priority: .userOpened)
        }
    }
}
