#if os(iOS)
/// AgentAvatar — Unified avatar component for agent display throughout the app.
///
/// Mirrors the web's AgentAvatar.tsx + agentInfo() with size variants,
/// status indicators, and badge overlays.

import SwiftUI

// MARK: - Avatar Size

enum AvatarSize {
    case sm  // 28pt
    case md  // 36pt

    var dimension: CGFloat {
        switch self {
        case .sm: return 28
        case .md: return 36
        }
    }

    var cornerRadius: CGFloat {
        switch self {
        case .sm: return 6
        case .md: return 8
        }
    }

    var emojiFont: CGFloat {
        switch self {
        case .sm: return 13
        case .md: return 17
        }
    }

    var badgeFont: CGFloat {
        switch self {
        case .sm: return 9
        case .md: return 11
        }
    }
}

// MARK: - Avatar Badge

enum AvatarBadge {
    case permission  // 🔑
    case question    // ❓

    var emoji: String {
        switch self {
        case .permission: return "🔑"
        case .question:   return "❓"
        }
    }
}

// MARK: - AgentAvatar View

struct AgentAvatar: View {
    let agent: String
    var size: AvatarSize = .md
    var status: SessionState? = nil
    var badge: AvatarBadge? = nil

    private var info: AgentInfo {
        AgentInfo.from(agent)
    }

    var body: some View {
        ZStack {
            // Background
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .fill(info.bgColor)
                .frame(width: size.dimension, height: size.dimension)

            // Emoji
            Text(info.emoji)
                .font(.system(size: size.emojiFont))
        }
        .overlay(alignment: .bottomTrailing) {
            badgeView
        }
    }

    @ViewBuilder
    private var badgeView: some View {
        if let badge {
            Text(badge.emoji)
                .font(.system(size: size.badgeFont))
                .offset(x: -2, y: -4)
        } else if status == .idle {
            Text("☕")
                .font(.system(size: size.badgeFont))
                .offset(x: -2, y: -4)
        }
    }
}

// MARK: - Agent Info

struct AgentInfo {
    let label: String
    let emoji: String
    let color: Color
    let bgColor: Color

    static func from(_ agent: String) -> AgentInfo {
        switch agent.lowercased() {
        case "copilot":
            return AgentInfo(
                label: "Copilot",
                emoji: "🤖",
                color: .kraki600,
                bgColor: Color.kraki500.opacity(0.15)
            )
        case "claude":
            return AgentInfo(
                label: "Claude",
                emoji: "🧠",
                color: .orange,
                bgColor: Color.orange.opacity(0.15)
            )
        case "codex":
            return AgentInfo(
                label: "Codex",
                emoji: "⚡",
                color: .ocean600,
                bgColor: Color.ocean500.opacity(0.15)
            )
        default:
            return AgentInfo(
                label: agent.capitalized,
                emoji: "🔮",
                color: .gray,
                bgColor: Color.gray.opacity(0.15)
            )
        }
    }
}

#endif
