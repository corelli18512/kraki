#if os(iOS)
import SwiftUI
import UIKit

/// The action slot rendered INSIDE a `TKBubbleCell` for a streaming / frozen
/// turn: tool chip, parallel-tool count, permission prompt, question prompt,
/// or terminal outcome (user_abort / failed).
///
/// Session runtime activity such as compaction is intentionally excluded. It
/// renders in page chrome and must never become bubble content.
///
/// This is the single source of action rendering — it replaces the old
/// `LiveAgentBubbleView.actionSection`. The cell hosts it as a subview so the
/// streaming card and a completed bubble are literally the same cell; there is
/// no separate "live card" component.
struct BubbleActionSlot: View {
    let action: ChatMessage
    var sessionMode: SessionMode = .discuss
    var onResolvePermission: (String, String?, String) -> Void = { _, _, _ in }
    var onAnswerQuestion: (String, String) -> Void = { _, _ in }

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
                        .font(.system(size: 13)).foregroundStyle(Color.textSecondary)
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
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func terminalOutcome(_ m: ChatMessage, failed: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: failed ? "xmark.octagon.fill" : "stop.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(failed ? Color.red : Color.textMuted)
            Text(failed ? "Turn failed" : "User aborted")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(failed ? Color.red : Color.textSecondary)
            if let msg = m.payload["message"]?.stringValue, !msg.isEmpty {
                Text(msg).font(.system(size: 12)).foregroundStyle(Color.textMuted)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }

    private func toolChip(_ m: ChatMessage, running: Bool) -> some View {
        HStack(spacing: 8) {
            if running {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: (m.payload["success"]?.boolValue ?? true) ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .font(.system(size: 13))
                    .foregroundStyle((m.payload["success"]?.boolValue ?? true) ? Color.green : Color.red)
            }
            Text(m.toolName ?? "tool").font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundStyle(Color.textPrimary)
            if let h = m.headline, !h.isEmpty {
                Text(h).font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.textSecondary)
                    .lineLimit(1).truncationMode(.middle)
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
                    permissionButton("Approve", message, decision: "approve", foreground: .white, fill: .green, border: .clear)
                    if writeInDiscuss {
                        permissionButton("Switch to Execute", message, decision: "execute", foreground: .orange, fill: .orange.opacity(0.12), border: .orange.opacity(0.35))
                    } else {
                        permissionButton("Allow in Session", message, decision: "always_allow", foreground: .green, fill: .green.opacity(0.12), border: .green.opacity(0.35))
                    }
                    permissionButton("Deny", message, decision: "deny", foreground: .red, fill: .red.opacity(0.10), border: .red.opacity(0.35))
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

    private func questionInput(_ m: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let question = m.question, !question.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "questionmark.circle")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.purple)
                    Text(LiveMarkdown.attributed(question))
                        .font(.system(size: 14))
                        .foregroundStyle(Color.textPrimary)
                        // Keep multiline question text in the action host's
                        // intrinsic height so the bottom of the bubble cannot
                        // clip the final lines.
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            if m.cancelled {
                Text("Question cancelled")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
            } else if let answer = m.answer {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Answered")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.purple)
                    Text(LiveMarkdown.attributed(answer))
                        .font(.system(size: 13))
                        .foregroundStyle(Color.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.purple.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.purple.opacity(0.3)))
            } else if let choices = m.choices, !choices.isEmpty {
                VStack(spacing: 6) {
                    ForEach(choices, id: \.self) { choice in
                        Button {
                            submitQuestionChoice(m, answer: choice)
                        } label: {
                            Text(LiveMarkdown.attributed(choice))
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

    private func submitQuestionChoice(_ message: ChatMessage, answer: String) {
        guard let questionId = message.questionId else { return }
        onAnswerQuestion(questionId, answer)
    }

    static func switchesToExecute(mode: SessionMode, toolName: String?) -> Bool {
        guard mode == .discuss, let toolName else { return false }
        return ["write", "write_file", "create", "create_file", "edit", "edit_file"].contains(toolName)
    }
}

/// UIKit wrapper that hosts `BubbleActionSlot` as a subview of `TKBubbleCell`.
/// Self-sizing: the cell sets its width, this view reports its height via the
/// callback (and re-reports on any layout change, so streaming / interaction
/// height changes propagate to the list).
final class BubbleActionHostView: UIView {
    var onResolvePermission: ((String, String?, String) -> Void)?
    var onAnswerQuestion: ((String, String) -> Void)?
    var onHeightChange: ((CGFloat) -> Void)?

    var hostingController: UIHostingController<BubbleActionSlot?>?
    private var actionIdentity: String?
    private var lastReportedHeight: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        clipsToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }

    func configure(action: ChatMessage?, sessionMode: SessionMode) {
        let nextIdentity = Self.identity(for: action)
        if actionIdentity != nextIdentity {
            hostingController?.view.removeFromSuperview()
            hostingController = nil
            actionIdentity = nextIdentity
            lastReportedHeight = 0
        }

        let slot = action.map { action in
            BubbleActionSlot(action: action, sessionMode: sessionMode,
                onResolvePermission: { [weak self] id, tool, dec in self?.onResolvePermission?(id, tool, dec) },
                onAnswerQuestion: { [weak self] id, ans in self?.onAnswerQuestion?(id, ans) })
        }
        if let existing = hostingController {
            existing.rootView = slot
            existing.view.invalidateIntrinsicContentSize()
            existing.view.setNeedsLayout()
        } else if slot != nil {
            let host = UIHostingController(rootView: slot)
            host.view.backgroundColor = .clear
            host.view.clipsToBounds = true
            host.view.translatesAutoresizingMaskIntoConstraints = false
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            host.view.frame = bounds
            addSubview(host.view)
            hostingController = host
        }
        setNeedsLayout()
    }

    private static func identity(for action: ChatMessage?) -> String? {
        guard let action else { return nil }
        switch action.type {
        case "permission":
            return "permission:\(action.permissionId ?? "unknown")"
        case "question":
            return "question:\(action.questionId ?? "unknown")"
        case "tool_start", "tool_complete":
            return "tool:\(action.toolCallId ?? action.headline ?? action.toolName ?? "unknown")"
        case "tool_batch":
            return "tool_batch"
        case "user_abort", "failed":
            return action.type
        default:
            return "\(action.type):\(action.id)"
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let hv = hostingController?.view else { return }
        hv.frame = bounds
        hv.setNeedsLayout()
        let target = CGSize(width: max(1, bounds.width), height: UIView.layoutFittingCompressedSize.height)
        let fit = hv.systemLayoutSizeFitting(target,
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel)
        if abs(fit.height - lastReportedHeight) > 0.5 {
            lastReportedHeight = fit.height
            onHeightChange?(fit.height)
        }
    }

    func measuredHeight(forWidth width: CGFloat) -> CGFloat {
        guard let hv = hostingController?.view else { return 0 }
        hv.frame = CGRect(x: 0, y: 0, width: max(1, width), height: 1)
        hv.setNeedsLayout()
        hv.layoutIfNeeded()
        let fit = hv.systemLayoutSizeFitting(CGSize(width: max(1, width), height: .greatestFiniteMagnitude),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel)
        return max(1, fit.height)
    }
}

/// Lightweight per-line inline markdown for a live draft / question text.
/// (Production spine bubbles reuse the finalized TextKit path; live draft text
/// is short and re-rendered per delta, so a cheap parse is fine.)
enum LiveMarkdown {
    static func attributed(_ text: String) -> AttributedString {
        var opts = AttributedString.MarkdownParsingOptions()
        opts.interpretedSyntax = .inlineOnlyPreservingWhitespace
        opts.failurePolicy = .returnPartiallyParsedIfPossible
        var out = AttributedString()
        let lines = text.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            out += (try? AttributedString(markdown: line, options: opts)) ?? AttributedString(line)
            if i < lines.count - 1 { out += AttributedString("\n") }
        }
        return out
    }
}
/// Used by `TKBubbleContent.cellHeight` so the list's cached heights agree with
/// what the cell actually lays out. A single shared (offscreen) host avoids
/// spinning up a `UIHostingController` per measure call.
enum TKActionMeasure {
    private static var shared: BubbleActionHostView?
    static func height(action: ChatMessage, width: CGFloat) -> CGFloat {
        // Compaction belongs to session runtime chrome, never to an action slot.
        guard action.type != "compaction" else { return 0 }
        // Measurement runs on the main thread (cellHeight is called from the
        // main-queue layout path); the SwiftUI host must be touched there.
        assert(Thread.isMainThread)
        let host = shared ?? BubbleActionHostView(frame: .zero)
        shared = host
        host.configure(action: action, sessionMode: .discuss)
        return host.measuredHeight(forWidth: width)
    }
}
#endif
