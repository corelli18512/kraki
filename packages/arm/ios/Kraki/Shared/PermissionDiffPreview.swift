import SwiftUI

/// Compact, colored preview of the change a file-edit permission would make,
/// so an approval in Safe mode is not blind. Reads the `content` slot that
/// Tentacle fills with a unified-style diff for edit tools (Claude Edit /
/// MultiEdit, Codex fileChange, Copilot write).
struct PermissionDiffPreview: View {
    let diff: String
    var fontSize: CGFloat = 11
    var maxLines: Int = 14

    /// The diff text for a permission's args, or nil when the args carry no
    /// diff (plain write with no content, shell, etc.).
    static func diff(_ args: [String: AnyCodable]?) -> String? {
        guard let content = args?["content"]?.stringValue ?? args?["diff"]?.stringValue,
              !content.isEmpty else { return nil }
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false)
        // Only treat it as a diff when it looks like one; a full new file is
        // still worth previewing, prefixed so it reads as an addition.
        let looksLikeDiff = lines.contains { $0.hasPrefix("+") || $0.hasPrefix("-") || $0.hasPrefix("@@") }
        return looksLikeDiff ? content : lines.map { "+\($0)" }.joined(separator: "\n")
    }

    var body: some View {
        let all = diff.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.hasPrefix("---") && !$0.hasPrefix("+++") }
        let shown = all.prefix(maxLines)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : String(line))
                    .font(.system(size: fontSize, design: .monospaced))
                    .foregroundStyle(color(for: line))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(background(for: line))
            }
            if all.count > shown.count {
                Text("… \(all.count - shown.count) more lines")
                    .font(.system(size: fontSize - 1))
                    .foregroundStyle(Color.textSecondary)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surfaceTertiary, in: RoundedRectangle(cornerRadius: 5))
        .accessibilityLabel("Proposed change")
    }

    private func color(for line: Substring) -> Color {
        if line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        return Color.textSecondary
    }

    private func background(for line: Substring) -> Color {
        if line.hasPrefix("+") { return .green.opacity(0.08) }
        if line.hasPrefix("-") { return .red.opacity(0.08) }
        return .clear
    }
}
