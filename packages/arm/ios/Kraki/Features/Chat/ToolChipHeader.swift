#if os(iOS)
/// ToolChipHeader — the visual row shown above the (optional) expanded
/// args/result body in a chat tool bubble.
///
/// Visually mirrors `ActivityRow` (used on session-card previews) but
/// supports a tri-state status badge that reflects start / success /
/// failure / cancellation, since chat surfaces both `tool_start` and
/// `tool_complete` messages with their outcomes.

import SwiftUI

/// Status of a tool invocation, as surfaced inline on the chat row.
enum ToolChipStatus {
    case running
    case success
    case failure
    case cancelled
}

struct ToolChipHeader: View {
    let toolName: String
    let headline: String?
    let status: ToolChipStatus
    /// When true, render a chevron and a hit target that toggles the
    /// caller's expansion state. Caller wires the toggle externally
    /// (we expose this as a bool so the chevron stays visually
    /// consistent across surfaces).
    var isExpandable: Bool = false
    var isExpanded: Bool = false
    var onTap: () -> Void = {}
    /// Optional background color for the tool-name pill. `nil` falls back
    /// to `systemGray6`. Chat surface passes a session-tinted color so the
    /// pill picks up the bubble's hue; session-card preview keeps `nil`.
    var pillTint: Color? = nil

    /// Default icon dimension for all tool glyphs. Uniform across the
    /// catalogue now that read/view uses Lucide `book-text` instead of
    /// the busier SF Symbol `eyes` that used to need a smaller render.
    private static let iconSize: CGFloat = 16
    /// Scale applied to the status badge so it sits as a small marker
    /// in the icon's bottom-right corner.
    private static let badgeScale: CGFloat = 0.55

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                iconWithBadge
                toolNamePill
                if let h = headline, !h.isEmpty {
                    Text(h.collapseWhitespace())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                if isExpandable {
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 0 : -90))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isExpandable)
    }

    // MARK: - Icon + status badge

    @ViewBuilder
    private var iconWithBadge: some View {
        let size = Self.iconSize
        ToolStatusIcon(toolName: toolName, size: size, color: .secondary)
            .frame(width: size, height: size)
            .overlay(alignment: .bottomTrailing) {
                statusBadge
                    .offset(x: badgeNudgeX, y: badgeNudgeY)
            }
            .padding(.trailing, 4)
    }

    /// The running spinner and the static success/failure glyphs have
    /// different visual centres at the same bottom-trailing anchor —
    /// the spinner's roundness wants a bit more offset down-right, and
    /// the SF Symbol checkmark/xmark wants to ride up-left to nest at
    /// the icon's actual corner. Tuned per-status nudges keep both
    /// looking properly anchored against the uniform 16pt icon frame.
    private var badgeNudgeX: CGFloat {
        switch status {
        case .running: return 8
        case .success, .failure, .cancelled: return 5
        }
    }

    private var badgeNudgeY: CGFloat {
        switch status {
        case .running: return 4
        case .success, .failure, .cancelled: return -1
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch status {
        case .running:
            ProgressView()
                .controlSize(.mini)
                .scaleEffect(Self.badgeScale)
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

    // MARK: - Tool-name pill

    @ViewBuilder
    private var toolNamePill: some View {
        Text(toolName)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(
                pillTint ?? Color(uiColor: .systemGray6),
                in: RoundedRectangle(cornerRadius: 4)
            )
    }
}
#endif
