#if os(iOS)
/// ToolActivityView — Collapsible tool invocation detail, mirroring
/// `web/src/components/chat/ToolActivity.tsx`.
///
/// As of v0.17+ (protocol PR #106), tool messages carry a
/// tentacle-composed `headline` inline plus `argsRef` / `resultRef`
/// lazy refs. The chip header shows the headline immediately; expanding
/// the chip subscribes to the refs via `AttachmentStore` and renders
/// the full args / result once bytes arrive.
///
/// Backwards-compat: permission prompts still ship the full args
/// dictionary inline (the operator must see them to approve). If
/// neither headline nor refs are present (cold cache from a pre-0.17
/// session, or a permission prompt), the inline-args fallback is used.

import SwiftUI

struct ToolActivityView: View {
    @Environment(AppState.self) private var appState

    let type: ToolActivityType
    let toolName: String
    /// Tentacle-composed headline (≤200 chars). Always present in v0.17+.
    let headline: String?
    /// Lazy ref to the full args JSON. Absent for trivially small args.
    let argsRef: ContentRef?
    /// Lazy ref to the full result. Always present on `tool_complete`
    /// except when the tool produced no output.
    let resultRef: ContentRef?
    /// Inline args, kept for permission-prompt path where the agent
    /// blocks waiting for approval and full args ship eagerly.
    let inlineArgs: [String: AnyCodable]?
    let sessionId: String
    var success: Bool? = nil
    var cancelled: Bool = false
    var forceExpanded: Bool = false

    @State private var expanded = false

    private var isExpanded: Bool { forceExpanded || expanded }

    private var attachmentStore: AttachmentStore { appState.attachmentStore }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ToolChipHeader(
                toolName: toolName,
                headline: headlineForDisplay,
                status: chipStatus,
                isExpandable: hasExpandableContent,
                isExpanded: isExpanded,
                onTap: {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                }
            )
            .padding(.vertical, 6)

            // Expanded content
            if isExpanded {
                expandedContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
                    .onAppear { triggerLazyFetches() }
            }
        }
    }

    private var chipStatus: ToolChipStatus {
        if type == .start {
            return cancelled ? .cancelled : .running
        }
        return success == false ? .failure : .success
    }

    private var hasExpandableContent: Bool {
        argsRef != nil
            || resultRef != nil
            || (inlineArgs?.isEmpty == false)
    }

    // MARK: - Headline (collapsed-state preview text)

    /// Prefer the tentacle's pre-composed headline. Fall back to a
    /// minimal client-side preview built from inline args (for legacy
    /// permission-prompt path).
    private var headlineForDisplay: String? {
        if let h = headline, !h.isEmpty { return h }
        guard let args = inlineArgs else { return nil }
        switch toolName.lowercased() {
        case "shell", "bash":
            if let cmd = args["command"]?.stringValue { return "$ \(cmd)" }
        case "read_file", "view", "read",
             "write_file", "edit_file", "edit", "create_file", "create", "write":
            if let path = args["path"]?.stringValue { return path }
        case "fetch_url":
            if let url = args["url"]?.stringValue { return url }
        case "grep", "search":
            if let pattern = args["pattern"]?.stringValue { return "/\(pattern)/" }
        case "glob":
            if let pattern = args["pattern"]?.stringValue { return pattern }
        default:
            // Prefer well-known argument names first; fall back to
            // iterating in a deterministic sort order so the chip
            // headline doesn't change between runs depending on
            // dictionary hash ordering.
            let preferredKeys = ["query", "path", "file", "url", "name", "id", "key"]
            for k in preferredKeys {
                if let s = args[k]?.stringValue, !s.isEmpty, s.count < 120 { return s }
            }
            for k in args.keys.sorted() {
                if let s = args[k]?.stringValue, !s.isEmpty, s.count < 120 { return s }
            }
        }
        return nil
    }

    // MARK: - Expanded Content

    @ViewBuilder
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            argsSection
            resultSection
            if argsRef == nil && resultRef == nil && (inlineArgs?.isEmpty ?? true) {
                // Nothing to show: tool ran with no args and no result.
                Text("(no args or result)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var argsSection: some View {
        if let argsRef {
            lazySection(title: "Arguments", ref: argsRef)
        } else if let args = inlineArgs, !args.isEmpty {
            // Legacy inline path (permission prompt).
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
    }

    @ViewBuilder
    private var resultSection: some View {
        if let resultRef {
            lazySection(title: "Result", ref: resultRef)
        }
    }

    /// Render one lazy-fetched body region — subscribes to
    /// `attachmentStore.states[ref.id]` via the @Observable mechanism.
    @ViewBuilder
    private func lazySection(title: String, ref: ContentRef) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            lazyBody(ref: ref)
        }
    }

    @ViewBuilder
    private func lazyBody(ref: ContentRef) -> some View {
        switch attachmentStore.state(for: ref.id) {
        case .ready(_, let data):
            ScrollView {
                Text(String(data: data, encoding: .utf8) ?? "(non-utf8 bytes)")
                    .font(.caption2)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 240)
        case .error(let reason):
            Text("Couldn't load: \(reason)")
                .font(.caption2)
                .foregroundStyle(.red)
        case .awaitingChunks(let received, let total):
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                if let t = total {
                    Text("Loading \(received)/\(t)…")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                } else {
                    Text("Loading…")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        case .fetching, .none:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Loading…")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    /// Kick off lazy fetches for both refs when the chip expands.
    private func triggerLazyFetches() {
        if let argsRef {
            attachmentStore.requestIfNeeded(id: argsRef.id, sessionId: sessionId)
        }
        if let resultRef {
            attachmentStore.requestIfNeeded(id: resultRef.id, sessionId: sessionId)
        }
    }

    // MARK: - Helpers

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
///
/// Caps each side at `maxLinesPerSide` lines to avoid the layout
/// stall that comes from a `VStack(ForEach)` over hundreds of lines.
/// When clipped, shows an "X more lines" affordance that lets the
/// user expand the block at their own discretion.
struct SimpleDiffView: View {
    let oldText: String
    let newText: String

    @State private var expanded = false

    private static let collapsedLinesPerSide = 60

    var body: some View {
        let oldLines = oldText.isEmpty ? [] : oldText.components(separatedBy: "\n")
        let newLines = newText.isEmpty ? [] : newText.components(separatedBy: "\n")
        let limit = expanded ? Int.max : Self.collapsedLinesPerSide
        let oldVisible = Array(oldLines.prefix(limit))
        let newVisible = Array(newLines.prefix(limit))
        let oldHidden = max(0, oldLines.count - oldVisible.count)
        let newHidden = max(0, newLines.count - newVisible.count)

        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(oldVisible.enumerated()), id: \.offset) { _, line in
                Text("- \(line)")
                    .font(.caption2)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 1)
                    .background(Color.red.opacity(0.08))
            }
            ForEach(Array(newVisible.enumerated()), id: \.offset) { _, line in
                Text("+ \(line)")
                    .font(.caption2)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.green)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 1)
                    .background(Color.green.opacity(0.08))
            }
            if oldHidden > 0 || newHidden > 0 {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    Text(expandedLabel(oldHidden: oldHidden, newHidden: newHidden))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.secondary.opacity(0.08))
                }
                .buttonStyle(.plain)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .textSelection(.enabled)
    }

    private func expandedLabel(oldHidden: Int, newHidden: Int) -> String {
        if expanded {
            return "  Collapse"
        }
        var pieces: [String] = []
        if oldHidden > 0 { pieces.append("\(oldHidden) removed") }
        if newHidden > 0 { pieces.append("\(newHidden) added") }
        return "  \(pieces.joined(separator: ", ")) — tap to expand"
    }
}

#endif
