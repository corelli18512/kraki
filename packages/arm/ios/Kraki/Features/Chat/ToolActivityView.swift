#if os(iOS)
/// ToolActivityView — Collapsible tool invocation detail, mirroring ToolActivity.tsx.
///
/// Shows a tool name + summary in collapsed state, expands to reveal
/// arguments, diff view, and result content.

import SwiftUI

struct ToolActivityView: View {
    let type: ToolActivityType
    let toolName: String
    let args: [String: AnyCodable]?
    let result: String?
    var forceExpanded: Bool = false

    @State private var expanded = false

    private var isExpanded: Bool { forceExpanded || expanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Header button
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    statusIcon
                    toolIcon
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    if type == .start {
                        Text("Running ")
                            .font(.caption2)
                            .fontWeight(.medium)
                            .foregroundStyle(.secondary)
                    }

                    Text(toolName)
                        .font(.caption2)
                        .fontWeight(.medium)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.blue)

                    if !summary.isEmpty {
                        Text(summary)
                            .font(.caption2)
                            .fontDesign(.monospaced)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: 0)

                    Image(systemName: "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 0 : -90))
                }
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Expanded content
            if isExpanded {
                expandedContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    // MARK: - Status Icon

    @ViewBuilder
    private var statusIcon: some View {
        if type == .start {
            ProgressView()
                .controlSize(.mini)
        } else {
            LucideIcon(.check, size: 12, color: .green)
        }
    }

    // MARK: - Tool Icon

    @ViewBuilder
    private var toolIcon: some View {
        switch toolName {
        case "shell", "bash":
            LucideIcon(.terminal, size: 12, color: .secondary)
        case "read_file", "view":
            LucideIcon(.fileText, size: 12, color: .secondary)
        case "write_file", "create_file", "create":
            LucideIcon(.fileEdit, size: 12, color: .secondary)
        case "edit_file", "edit":
            LucideIcon(.pencil, size: 12, color: .secondary)
        case "grep", "search":
            LucideIcon(.search, size: 12, color: .secondary)
        case "glob":
            LucideIcon(.folderSearch, size: 12, color: .secondary)
        case "mcp":
            Image(systemName: "server.rack")
        default:
            Image(systemName: "wrench")
        }
    }

    // MARK: - Summary

    private var summary: String {
        guard let args else { return "" }
        switch toolName {
        case "shell", "bash":
            if let cmd = args["command"]?.stringValue { return "$ \(cmd)" }
        case "write_file", "edit_file", "edit", "create_file", "create", "read_file", "view":
            if let path = args["path"]?.stringValue { return path }
        case "fetch_url":
            if let url = args["url"]?.stringValue { return url }
        case "mcp":
            let server = args["server"]?.stringValue ?? ""
            let tool = args["tool"]?.stringValue ?? ""
            return "\(server)/\(tool)"
        case "grep", "search":
            if let pattern = args["pattern"]?.stringValue { return "/\(pattern)/" }
        case "glob":
            if let pattern = args["pattern"]?.stringValue { return pattern }
        default:
            // First short string arg as preview
            for (_, v) in (args) {
                if let s = v.stringValue, !s.isEmpty, s.count < 120 { return s }
            }
        }
        return ""
    }

    // MARK: - Expanded Content

    @ViewBuilder
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Summary detail
            if !summary.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(detailLabel)
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    Text(summary)
                        .font(.caption2)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            // Edit diff view
            if let diff = editDiff {
                SimpleDiffView(oldText: diff.old, newText: diff.new)
            } else if let argsDetail {
                // Additional args detail
                VStack(alignment: .leading, spacing: 2) {
                    Text(argsDetail.label)
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(argsDetail.content)
                            .font(.caption2)
                            .fontDesign(.monospaced)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 160)
                }
            } else if let args, !args.isEmpty, summary.isEmpty {
                // Fallback: raw args JSON
                VStack(alignment: .leading, spacing: 2) {
                    Text("Arguments")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    Text(formatArgs(args))
                        .font(.caption2)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            // Result
            if let result, !result.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Result")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    ScrollView {
                        Text(result)
                            .font(.caption2)
                            .fontDesign(.monospaced)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 240)
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Helpers

    private var detailLabel: String {
        switch toolName {
        case "shell", "bash": return "Command"
        case "read_file", "view", "write_file", "edit_file", "edit", "create_file", "create": return "Path"
        case "grep", "search", "glob": return "Pattern"
        case "fetch_url": return "URL"
        default: return "Summary"
        }
    }

    private var argsDetail: (label: String, content: String)? {
        guard let args else { return nil }
        switch toolName {
        case "edit", "edit_file":
            let oldStr = args["old_str"]?.stringValue
            let newStr = args["new_str"]?.stringValue
            guard oldStr != nil || newStr != nil else { return nil }
            var parts: [String] = []
            if let o = oldStr { parts.append("- \(o)") }
            if let n = newStr { parts.append("+ \(n)") }
            return ("Changes", parts.joined(separator: "\n"))
        case "write_file", "create_file", "create":
            let content = args["file_text"]?.stringValue ?? args["content"]?.stringValue
            guard let content else { return nil }
            let preview = content.count > 500 ? String(content.prefix(497)) + "…" : content
            return ("Content", preview)
        case "grep", "search":
            if let path = args["path"]?.stringValue { return ("Directory", path) }
            return nil
        default:
            return nil
        }
    }

    private var editDiff: (old: String, new: String)? {
        guard let args else { return nil }
        let oldStr = args["old_str"]?.stringValue ?? ""
        let newStr = args["new_str"]?.stringValue ?? ""
        guard !oldStr.isEmpty || !newStr.isEmpty else { return nil }
        return (oldStr, newStr)
    }

    private func formatArgs(_ args: [String: AnyCodable]) -> String {
        let pairs = args.sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value)" }
        return pairs.joined(separator: "\n")
    }
}

// MARK: - ToolActivityType

enum ToolActivityType {
    case start
    case complete
}

// MARK: - SimpleDiffView

/// Minimal diff view showing old (red) and new (green) lines.
struct SimpleDiffView: View {
    let oldText: String
    let newText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !oldText.isEmpty {
                ForEach(Array(oldText.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    Text("- \(line)")
                        .font(.caption2)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 1)
                        .background(Color.red.opacity(0.08))
                }
            }
            if !newText.isEmpty {
                ForEach(Array(newText.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    Text("+ \(line)")
                        .font(.caption2)
                        .fontDesign(.monospaced)
                        .foregroundStyle(.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 1)
                        .background(Color.green.opacity(0.08))
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .textSelection(.enabled)
    }
}

#endif
