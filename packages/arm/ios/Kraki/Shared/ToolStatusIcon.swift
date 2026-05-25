#if os(iOS)
/// ToolStatusIcon — Small glyph that reflects what a session's agent is
/// currently doing, based on the in-flight tool call's name. Rendered as
/// a corner badge on `AgentAvatar`.
///
/// The mapping mirrors the inline icons in `ToolActivityView.swift` for
/// the in-chat tool bubbles, but the visual treatment differs: this
/// view is sized and stroked for use at avatar-badge scale.

import SwiftUI

struct ToolStatusIcon: View {
    let toolName: String
    var size: CGFloat = 12
    var color: Color = .secondary

    /// Normalize tool names across agents. Copilot uses snake_case
    /// (`read_file`), Claude uses TitleCase (`Read`, `Bash`, `Edit`,
    /// `Grep`, `Glob`, `WebFetch`, `WebSearch`). MCP-tool names like
    /// `mcp__github__search_repositories` and `playwright__browser_click`
    /// fan out further. We canonicalize to a small set of groups.
    private var group: Group {
        let lower = toolName.lowercased()
        if lower.hasPrefix("mcp__") || lower.hasPrefix("mcp-") || lower == "mcp" {
            // MCP namespaced tools — look at the action segment after server name.
            // mcp__github__search_repositories → "search_repositories"
            let parts = lower.split(separator: "_", omittingEmptySubsequences: true)
            if parts.contains(where: { $0.contains("search") }) { return .search }
            if parts.contains(where: { $0.contains("fetch") || $0.contains("get") }) { return .fetch }
            if parts.contains(where: { $0.contains("browser") || $0.contains("click") || $0.contains("playwright") }) { return .playwright }
            return .mcp
        }
        if lower.contains("playwright") || lower.contains("browser_") {
            return .playwright
        }
        switch lower {
        case "shell", "bash", "run", "command":
            return .shell
        case "read_file", "read", "view", "view_file", "open", "cat":
            return .read
        case "write_file", "write", "create_file", "create", "new_file":
            return .write
        case "edit_file", "edit", "patch", "str_replace_editor":
            return .edit
        case "grep", "search", "search_code", "search_files", "ripgrep", "rg":
            return .search
        case "glob", "list_files", "find":
            return .glob
        case "fetch_url", "webfetch", "web_fetch", "fetch", "websearch", "web_search":
            return .fetch
        default:
            return .other
        }
    }

    private enum Group {
        case shell, read, write, edit, search, glob, fetch, playwright, mcp, other
    }

    var body: some View {
        switch group {
        case .shell:
            LucideIcon(.squareTerminal, size: size, color: color)
        case .read:
            LucideIcon(.bookText, size: size, color: color)
        case .write, .edit:
            LucideIcon(.chevronsLeftRightEllipsis, size: size, color: color)
        case .search:
            LucideIcon(.searchCode, size: size, color: color)
        case .glob:
            LucideIcon(.fileSearch, size: size, color: color)
        case .fetch:
            Image(systemName: "link")
                .font(.system(size: size * 0.9, weight: .medium))
                .foregroundStyle(color)
        case .playwright:
            LucideIcon(.squareMousePointer, size: size, color: color)
        case .mcp:
            Image(systemName: "server.rack")
                .font(.system(size: size * 0.9, weight: .medium))
                .foregroundStyle(color)
        case .other:
            Image(systemName: "wrench")
                .font(.system(size: size * 0.85, weight: .medium))
                .foregroundStyle(color)
        }
    }
}

#if DEBUG
/// Visual gallery showing every recognized tool icon rendered as it
/// would appear on an `AgentAvatar` badge. Used for one-off layout
/// verification when wiring a new tool group.
struct ToolStatusIconGallery: View {
    private let samples: [(String, String)] = [
        ("shell", "bash"),
        ("read", "Read"),
        ("write", "Write"),
        ("edit", "Edit"),
        ("grep", "Grep"),
        ("glob", "Glob"),
        ("fetch", "WebFetch"),
        ("playwright", "playwright_click"),
        ("mcp", "mcp__github__search_repositories"),
        ("default", "something_weird"),
    ]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 80))], spacing: 16) {
            ForEach(samples, id: \.1) { label, tool in
                VStack(spacing: 6) {
                    AgentAvatar(
                        agent: "copilot",
                        sessionId: tool,
                        size: .md,
                        status: .active
                    )
                    Text(label).font(.caption2).foregroundStyle(.secondary)
                    Text(tool).font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .padding(24)
    }
}
#endif

#endif
