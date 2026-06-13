#if os(iOS)
/// ActivityRow — the "session is working" affordance shown inside a
/// session card while `session.state == .active`.
///
/// Reuses the chat-bubble's `ToolChipHeader` for the tool variants so
/// the corner badge (running / success / failure / cancelled) and pill
/// styling stay consistent with the expanded chat view. The empty
/// case ("nothing concrete yet") shows the last user message with a
/// leading `circle-user` icon so the card always carries the prompt
/// that kicked off the turn — never the generic "Thinking…".

import SwiftUI

struct ActivityRow: View {
    let activity: SessionActivity
    /// Text of the last `user_message` in the session. Used by the
    /// `.none` case to remind the user what was just asked.
    let lastUserMessage: String?

    private static let leadingIconSize: CGFloat = 14

    var body: some View {
        HStack(spacing: 6) {
            switch activity {
            case .toolRunning(let toolName, let headline):
                ToolChipHeader(toolName: toolName, headline: headline, status: .running)
            case .toolComplete(let toolName, let headline, let success):
                ToolChipHeader(toolName: toolName, headline: headline,
                               status: success == false ? .failure : .success)
            case .agentText(let text):
                LucideIcon(.keyboard, size: Self.leadingIconSize, color: .secondary)
                Text(text.collapseWhitespace())
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            case .none:
                LucideIcon(.circleUser, size: Self.leadingIconSize, color: .krakiPrimary.opacity(0.55))
                if let user = lastUserMessage, !user.isEmpty {
                    Text(user.collapseWhitespace())
                        .font(.footnote)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        }
    }
}
#endif



