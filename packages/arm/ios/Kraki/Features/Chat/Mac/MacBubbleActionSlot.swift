#if os(macOS)
import SwiftUI

/// The action slot rendered INSIDE a Mac chat bubble for a streaming or frozen
/// turn. This intentionally mirrors iOS `BubbleActionSlot`: tool activity,
/// permission/question prompts, and terminal outcomes all remain part of the
/// live bubble rather than being duplicated in the composer.
struct MacBubbleActionSlot: View {
    let action: ChatMessage
    var sessionMode: SessionMode = .discuss
    var onResolvePermission: (String, String?, String) -> Void = { _, _, _ in }
    var onAnswerQuestion: (String, String) -> Void = { _, _ in }

    var body: some View {
        switch action.type {
        case "tool_start": toolChip(action, running: true)
        case "tool_complete": toolChip(action, running: false)
        case "tool_batch":
            HStack(spacing: 8) {
                ProgressView().controlSize(.mini)
                Text("\(action.payload["running"]?.intValue ?? 0) 个工具并行运行中…")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.textSecondary)
            }
        case "permission": permissionInput(action)
        case "question": questionInput(action)
        case "user_abort": terminalOutcome(action, failed: false)
        case "failed": terminalOutcome(action, failed: true)
        default: EmptyView()
        }
    }

    private func terminalOutcome(_ message: ChatMessage, failed: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: failed ? "xmark.octagon.fill" : "stop.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(failed ? Color.red : Color.textMuted)
            Text(failed ? "Turn failed" : "User aborted")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(failed ? Color.red : Color.textSecondary)
            if let text = message.payload["message"]?.stringValue, !text.isEmpty {
                Text(text)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }

    private func toolChip(_ message: ChatMessage, running: Bool) -> some View {
        HStack(spacing: 8) {
            if running {
                ProgressView().controlSize(.mini)
            } else {
                let success = message.payload["success"]?.boolValue ?? true
                Image(systemName: success ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(success ? Color.green : Color.red)
            }
            Text(message.toolName ?? "tool")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.textPrimary)
            if let headline = message.headline, !headline.isEmpty {
                Text(headline)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }

    private func permissionInput(_ message: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
                (Text("Permission · ").font(.system(size: 12, weight: .medium))
                    + Text(message.toolName ?? "")
                        .font(.system(size: 12, weight: .medium, design: .monospaced)))
                    .foregroundStyle(.orange)
            }
            Text(message.toolDescription ?? message.toolName ?? "")
                .font(.system(size: 14, design: .monospaced))
                .foregroundStyle(Color.textPrimary)
            if let decision = message.payload["decision"]?.stringValue {
                Text(decision == "deny" ? "Denied" : decision == "always_allow" ? "Allowed for session" : "Approved")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(decision == "deny" ? .red : .green)
            } else {
                HStack(spacing: 8) {
                    permissionButton("Approve", message, decision: "approve", tint: .green)
                    if Self.switchesToExecute(mode: sessionMode, toolName: message.toolName) {
                        permissionButton("Execute", message, decision: "execute", tint: .orange)
                    } else {
                        permissionButton("Always", message, decision: "always_allow", tint: .krakiPrimary)
                    }
                    permissionButton("Deny", message, decision: "deny", tint: .red)
                }
            }
        }
    }

    private func permissionButton(
        _ label: String,
        _ message: ChatMessage,
        decision: String,
        tint: Color
    ) -> some View {
        Button {
            guard let permissionId = message.permissionId else { return }
            onResolvePermission(permissionId, message.toolName, decision)
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(tint, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) permission")
    }

    private func questionInput(_ message: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let question = message.question, !question.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "questionmark.circle")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.purple)
                    Text(MacLiveMarkdown.attributed(question))
                        .font(.system(size: 14))
                        .foregroundStyle(Color.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if message.cancelled {
                Text("Question cancelled")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
            } else if let answer = message.answer {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Answered")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.purple)
                    Text(MacLiveMarkdown.attributed(answer))
                        .font(.system(size: 13))
                        .foregroundStyle(Color.textPrimary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.purple.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.purple.opacity(0.3)))
            } else if let choices = message.choices, !choices.isEmpty {
                VStack(spacing: 6) {
                    ForEach(choices, id: \.self) { choice in
                        Button {
                            guard let questionId = message.questionId else { return }
                            onAnswerQuestion(questionId, choice)
                        } label: {
                            Text(MacLiveMarkdown.attributed(choice))
                                .font(.system(size: 13))
                                .foregroundStyle(Color.textPrimary)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 9)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.surfacePrimary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.borderPrimary))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Answer: \(choice)")
                    }
                }
            }
        }
    }

    static func switchesToExecute(mode: SessionMode, toolName: String?) -> Bool {
        guard mode == .discuss, let toolName else { return false }
        return ["write", "write_file", "create", "edit"].contains(toolName)
    }
}

private enum MacLiveMarkdown {
    static func attributed(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        options.failurePolicy = .returnPartiallyParsedIfPossible
        var output = AttributedString()
        let lines = text.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            output += (try? AttributedString(markdown: line, options: options)) ?? AttributedString(line)
            if index < lines.count - 1 { output += AttributedString("\n") }
        }
        return output
    }
}
#endif
