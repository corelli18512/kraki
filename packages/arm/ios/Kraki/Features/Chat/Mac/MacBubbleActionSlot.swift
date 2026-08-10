#if os(macOS)
import SwiftUI

struct MacQuestionChoiceFrame: Equatable {
    let answer: String
    let rect: CGRect
}

struct MacPermissionButtonFrame: Equatable {
    let decision: String
    let rect: CGRect
}

private struct MacQuestionChoiceFramePreferenceKey: PreferenceKey {
    static var defaultValue: [MacQuestionChoiceFrame] = []

    static func reduce(
        value: inout [MacQuestionChoiceFrame],
        nextValue: () -> [MacQuestionChoiceFrame]
    ) {
        value.append(contentsOf: nextValue())
    }
}

private struct MacPermissionButtonFramePreferenceKey: PreferenceKey {
    static var defaultValue: [MacPermissionButtonFrame] = []

    static func reduce(
        value: inout [MacPermissionButtonFrame],
        nextValue: () -> [MacPermissionButtonFrame]
    ) {
        value.append(contentsOf: nextValue())
    }
}

/// The action slot rendered INSIDE a Mac chat bubble for a streaming or frozen
/// turn. This intentionally mirrors iOS `BubbleActionSlot`: tool activity,
/// permission/question prompts, and terminal outcomes all remain part of the
/// live bubble rather than being duplicated in the composer.
struct MacBubbleActionSlot: View {
    private static let actionCoordinateSpace = "mac-bubble-action-space"
    let action: ChatMessage
    var sessionMode: SessionMode = .discuss
    var onResolvePermission: (String, String?, String) -> Void = { _, _, _ in }
    var onAnswerQuestion: (String, String) -> Void = { _, _ in }
    var onQuestionChoiceFramesChanged: ([MacQuestionChoiceFrame]) -> Void = { _ in }
    var onPermissionButtonFramesChanged: ([MacPermissionButtonFrame]) -> Void = { _ in }

    var body: some View {
        Group {
            switch action.type {
            case "tool_start": toolChip(action, running: true)
            case "tool_complete": toolChip(action, running: false)
            case "tool_batch":
                let running = action.payload["running"]?.intValue ?? 0
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                    Text(running == 1 ? "1 tool running in parallel…" : "\(running) tools running in parallel…")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.textSecondary)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case "permission": permissionInput(action)
            case "question": questionInput(action)
            case "user_abort": terminalOutcome(action, failed: false)
            case "failed": terminalOutcome(action, failed: true)
            default: EmptyView()
            }
        }
        .coordinateSpace(name: Self.actionCoordinateSpace)
        .onPreferenceChange(MacQuestionChoiceFramePreferenceKey.self) { frames in
            onQuestionChoiceFramesChanged(frames)
        }
        .onPreferenceChange(MacPermissionButtonFramePreferenceKey.self) { frames in
            onPermissionButtonFramesChanged(frames)
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
        let writeInDiscuss = Self.switchesToExecute(mode: sessionMode, toolName: message.toolName)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(.orange)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    if message.payload["decision"]?.stringValue == nil {
                        Text(writeInDiscuss ? "Write Approval — Discuss Mode" : "Permission Required")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.orange)
                    }
                    Text(message.toolDescription ?? "Run \(message.toolName ?? "tool")")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let summary = permissionArgsSummary(message),
                       summary != message.toolDescription {
                        Text(summary)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Color.textSecondary)
                            .lineLimit(3)
                            .truncationMode(.middle)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.surfaceTertiary, in: RoundedRectangle(cornerRadius: 5))
                    }
                    if let decision = message.payload["decision"]?.stringValue {
                        let denied = decision == "deny"
                        Text("\(denied ? "✗" : "✓") \(decision == "always_allow" ? "Always allowed" : denied ? "Denied" : "Approved")")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(denied ? .red : .green)
                            .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if message.payload["decision"]?.stringValue == nil {
                HStack(spacing: 8) {
                    permissionButton(
                        "Approve",
                        message,
                        decision: "approve",
                        foreground: .white,
                        fill: .green,
                        border: .clear
                    )
                    if writeInDiscuss {
                        permissionButton(
                            "Switch to Execute",
                            message,
                            decision: "execute",
                            foreground: .orange,
                            fill: .orange.opacity(0.12),
                            border: .orange.opacity(0.35)
                        )
                    } else {
                        permissionButton(
                            "Allow in Session",
                            message,
                            decision: "always_allow",
                            foreground: .green,
                            fill: .green.opacity(0.12),
                            border: .green.opacity(0.35)
                        )
                    }
                    permissionButton(
                        "Deny",
                        message,
                        decision: "deny",
                        foreground: .red,
                        fill: .red.opacity(0.10),
                        border: .red.opacity(0.35)
                    )
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func permissionButton(
        _ label: String,
        _ message: ChatMessage,
        decision: String,
        foreground: Color,
        fill: Color,
        border: Color
    ) -> some View {
        Button {
            guard let permissionId = message.permissionId else { return }
            onResolvePermission(permissionId, message.toolName, decision)
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(foreground)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .frame(maxWidth: .infinity, minHeight: 32)
                .background(fill, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(border, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("\(label) permission")
        .background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: MacPermissionButtonFramePreferenceKey.self,
                    value: [MacPermissionButtonFrame(
                        decision: decision,
                        rect: proxy.frame(in: .named(Self.actionCoordinateSpace))
                    )]
                )
            }
        }
    }

    private func permissionArgsSummary(_ message: ChatMessage) -> String? {
        guard let args = message.args else { return nil }
        let tool = (message.toolName ?? "").lowercased()
        switch tool {
        case "shell", "bash":
            return args["command"]?.stringValue
        case "write_file", "edit_file", "create_file", "read_file", "view":
            return args["path"]?.stringValue
        case "fetch_url":
            return args["url"]?.stringValue
        default:
            return args.values.compactMap(\.stringValue).first { !$0.isEmpty && $0.count < 200 }
        }
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
                        .background {
                            GeometryReader { proxy in
                                Color.clear.preference(
                                    key: MacQuestionChoiceFramePreferenceKey.self,
                                    value: [MacQuestionChoiceFrame(
                                        answer: choice,
                                        rect: proxy.frame(
                                            in: .named(Self.actionCoordinateSpace)
                                        )
                                    )]
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    static func switchesToExecute(mode: SessionMode, toolName: String?) -> Bool {
        guard mode == .discuss, let toolName else { return false }
        return ["write", "write_file", "create", "create_file", "edit", "edit_file"].contains(toolName)
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
