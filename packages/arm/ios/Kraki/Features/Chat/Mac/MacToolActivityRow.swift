#if os(macOS)
import SwiftUI

/// macOS counterpart of iOS `ToolActivityView` + `ToolChipHeader`.
struct MacToolActivityRow: View {
    let message: ChatMessage
    let sessionId: String

    @Environment(AppState.self) private var appState
    @State private var expanded = false

    private var isRunning: Bool { message.type == "tool_start" }
    private var status: Status {
        if isRunning { return message.cancelled ? .cancelled : .running }
        return (message.payload["success"]?.boolValue ?? true) ? .success : .failure
    }

    private enum Status {
        case running, success, failure, cancelled
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
                .padding(.vertical, 6)
            if expanded {
                expandedContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
                    .onAppear { triggerLazyFetches() }
            }
        }
    }

    private var header: some View {
        Button {
            guard hasExpandableContent else { return }
            withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                iconWithBadge
                toolNamePill
                if let headline = headlineForDisplay, !headline.isEmpty {
                    Text(headline.collapseWhitespace())
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                if hasExpandableContent {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 0 : -90))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!hasExpandableContent)
    }

    private var iconWithBadge: some View {
        MacToolStatusIcon(toolName: message.toolName ?? "tool", size: 16, color: .secondary)
            .frame(width: 16, height: 16)
            .overlay(alignment: .bottomTrailing) {
                statusBadge
                    .offset(x: badgeNudgeX, y: badgeNudgeY)
            }
            .padding(.trailing, 4)
    }

    private var badgeNudgeX: CGFloat {
        status == .running ? 8 : 5
    }

    private var badgeNudgeY: CGFloat {
        status == .running ? 4 : -1
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch status {
        case .running:
            ProgressView()
                .controlSize(.mini)
                .scaleEffect(0.55)
                .tint(.krakiPrimary)
        case .success:
            Image(systemName: "checkmark.circle")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.green)
        case .failure:
            Image(systemName: "xmark.circle")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.red)
        case .cancelled:
            Image(systemName: "minus.circle")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.orange)
        }
    }

    private var toolNamePill: some View {
        Text(message.toolName ?? "tool")
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color.surfaceTertiary, in: RoundedRectangle(cornerRadius: 4))
    }

    private var hasExpandableContent: Bool {
        message.argsRef != nil
            || message.resultRef != nil
            || (message.args?.isEmpty == false)
    }

    private var headlineForDisplay: String? {
        if let headline = message.headline, !headline.isEmpty { return headline }
        guard let args = message.args else { return nil }
        let tool = (message.toolName ?? "").lowercased()
        switch tool {
        case "shell", "bash":
            if let command = args["command"]?.stringValue { return "$ \(command)" }
        case "read_file", "view", "read", "write_file", "edit_file", "edit", "create_file", "create", "write":
            if let path = args["path"]?.stringValue { return path }
        case "fetch_url":
            if let url = args["url"]?.stringValue { return url }
        case "grep", "search":
            if let pattern = args["pattern"]?.stringValue { return "/\(pattern)/" }
        case "glob":
            if let pattern = args["pattern"]?.stringValue { return pattern }
        default:
            let preferred = ["query", "path", "file", "url", "name", "id", "key"]
            for key in preferred {
                if let value = args[key]?.stringValue, !value.isEmpty, value.count < 120 { return value }
            }
            for key in args.keys.sorted() {
                if let value = args[key]?.stringValue, !value.isEmpty, value.count < 120 { return value }
            }
        }
        return nil
    }

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let argsRef = message.argsRef {
                lazySection(title: "Arguments", ref: argsRef)
            } else if let args = message.args, !args.isEmpty {
                textSection(title: "Arguments", body: formatArgs(args))
            }
            if let resultRef = message.resultRef {
                lazySection(title: "Result", ref: resultRef)
            }
            if message.argsRef == nil,
               message.resultRef == nil,
               (message.args?.isEmpty ?? true) {
                Text("(no args or result)")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }

    private func textSection(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 11))
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            Text(body)
                .font(.system(size: 11))
                .fontDesign(.monospaced)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    private func lazySection(title: String, ref: ContentRef) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 11))
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            lazyBody(ref)
        }
    }

    @ViewBuilder
    private func lazyBody(_ ref: ContentRef) -> some View {
        if let store = appState.attachmentStore {
            switch store.state(for: ref.id) {
            case .ready(_, let data):
                ScrollView {
                    Text(String(data: data, encoding: .utf8) ?? "(non-utf8 bytes)")
                        .font(.system(size: 11))
                        .fontDesign(.monospaced)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
            case .error(let reason):
                Text("Couldn't load: \(reason)")
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            case .awaitingChunks(let received, let total):
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(total.map { "Loading \(received)/\($0)…" } ?? "Loading…")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
            case .fetching, .none:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Loading…")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func triggerLazyFetches() {
        if let ref = message.argsRef {
            appState.attachmentStore?.requestIfNeeded(id: ref.id, sessionId: sessionId)
        }
        if let ref = message.resultRef {
            appState.attachmentStore?.requestIfNeeded(id: ref.id, sessionId: sessionId)
        }
    }

    private func formatArgs(_ args: [String: AnyCodable]) -> String {
        args.sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value)" }
            .joined(separator: "\n")
    }
}

private struct MacToolStatusIcon: View {
    let toolName: String
    var size: CGFloat = 12
    var color: Color = .secondary

    private enum Group { case shell, read, write, edit, search, glob, fetch, playwright, mcp, other }

    private var group: Group {
        let lower = toolName.lowercased()
        if lower.hasPrefix("mcp__") || lower.hasPrefix("mcp-") || lower == "mcp" {
            let parts = lower.split(separator: "_", omittingEmptySubsequences: true)
            if parts.contains(where: { $0.contains("search") }) { return .search }
            if parts.contains(where: { $0.contains("fetch") || $0.contains("get") }) { return .fetch }
            if parts.contains(where: { $0.contains("browser") || $0.contains("click") || $0.contains("playwright") }) { return .playwright }
            return .mcp
        }
        if lower.contains("playwright") || lower.contains("browser_") { return .playwright }
        switch lower {
        case "shell", "bash", "run", "command": return .shell
        case "read_file", "read", "view", "view_file", "open", "cat": return .read
        case "write_file", "write", "create_file", "create", "new_file": return .write
        case "edit_file", "edit", "patch", "str_replace_editor": return .edit
        case "grep", "search", "search_code", "search_files", "ripgrep", "rg": return .search
        case "glob", "list_files", "find": return .glob
        case "fetch_url", "webfetch", "web_fetch", "fetch", "websearch", "web_search": return .fetch
        default: return .other
        }
    }

    @ViewBuilder
    var body: some View {
        switch group {
        case .shell: LucideIcon(.squareTerminal, size: size, color: color)
        case .read: LucideIcon(.bookText, size: size, color: color)
        case .write, .edit: LucideIcon(.chevronsLeftRightEllipsis, size: size, color: color)
        case .search: LucideIcon(.searchCode, size: size, color: color)
        case .glob: LucideIcon(.fileSearch, size: size, color: color)
        case .fetch:
            Image(systemName: "link").font(.system(size: size * 0.9, weight: .medium)).foregroundStyle(color)
        case .playwright: LucideIcon(.squareMousePointer, size: size, color: color)
        case .mcp:
            Image(systemName: "server.rack").font(.system(size: size * 0.9, weight: .medium)).foregroundStyle(color)
        case .other:
            Image(systemName: "wrench").font(.system(size: size * 0.85, weight: .medium)).foregroundStyle(color)
        }
    }
}
#endif
