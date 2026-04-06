#if os(iOS)
/// SessionCardView — A single session row in the list.
///
/// Mirrors SessionCard.tsx mobile appearance:
/// - HStack with avatar (badge + unread dot), center text (title, device, preview), timestamp.

import SwiftUI

struct SessionCardView: View {
    @Environment(AppState.self) private var appState

    let session: SessionInfo

    // MARK: - Derived State

    private var sessionStore: SessionStore { appState.sessionStore }
    private var deviceStore: DeviceStore { appState.deviceStore }

    private var device: DeviceSummary? {
        deviceStore.devices[session.deviceId]
    }

    private var isDeviceOnline: Bool {
        device?.online ?? false
    }

    private var machineName: String? {
        let name = session.deviceName.isEmpty ? device?.name : session.deviceName
        return name?.isEmpty == true ? nil : name
    }

    private var unreadCount: Int {
        sessionStore.activeSessionId == session.id
            ? 0
            : (sessionStore.unreadCounts[session.id] ?? 0)
    }

    private var isUnread: Bool { unreadCount > 0 }

    private var preview: SessionPreview? {
        sessionStore.sessionPreviews[session.id]
    }

    private var draft: String? {
        sessionStore.drafts[session.id]
    }

    private var isActiveSession: Bool {
        sessionStore.activeSessionId == session.id
    }

    private var agentLabel: String {
        AgentInfo.from(session.agent).label
    }

    // MARK: - Body

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            avatarView
            centerContent
            Spacer(minLength: 0)
            timestampView
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    // MARK: - Avatar

    private var avatarView: some View {
        ZStack(alignment: .topTrailing) {
            agentAvatar
                .overlay(alignment: .bottomTrailing) {
                    badgeOverlay
                }

            if isUnread {
                Circle()
                    .fill(.blue)
                    .frame(width: 8, height: 8)
                    .offset(x: 2, y: -2)
            }
        }
    }

    private var agentAvatar: some View {
        let info = AgentInfo.from(session.agent)
        return ZStack {
            Circle()
                .fill(info.color.opacity(0.15))
                .frame(width: 32, height: 32)

            Text(info.emoji)
                .font(.system(size: 14))
        }
        .overlay(alignment: .bottomTrailing) {
            statusDot
        }
    }

    @ViewBuilder
    private var statusDot: some View {
        if isDeviceOnline {
            Circle()
                .fill(session.state == .active ? Color.blue : Color.green)
                .frame(width: 8, height: 8)
                .overlay(
                    Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5)
                )
                .offset(x: 2, y: 2)
        }
    }

    @ViewBuilder
    private var badgeOverlay: some View {
        if let preview, preview.type == "permission" {
            Text("🔑")
                .font(.system(size: 10))
                .padding(2)
                .background(.ultraThinMaterial, in: Circle())
                .offset(x: 6, y: 4)
        } else if let preview, preview.type == "question" {
            Text("❓")
                .font(.system(size: 10))
                .padding(2)
                .background(.ultraThinMaterial, in: Circle())
                .offset(x: 6, y: 4)
        }
    }

    // MARK: - Center Content

    private var centerContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            // Title row
            HStack(spacing: 4) {
                Text(session.displayTitle)
                    .font(.headline)
                    .lineLimit(1)

                if !isDeviceOnline {
                    Text("offline")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
            }

            // Device + agent + model
            HStack(spacing: 4) {
                if let name = machineName {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 6, height: 6)

                    Text(name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if session.title != nil || session.autoTitle != nil {
                    if machineName != nil {
                        Text("·")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(agentLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let model = session.model {
                    Text(model)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            // Preview / draft
            previewText
        }
    }

    private var statusColor: Color {
        if !isDeviceOnline { return .gray }
        return session.state == .active ? .blue : .green
    }

    @ViewBuilder
    private var previewText: some View {
        if let draft, !isActiveSession {
            HStack(spacing: 2) {
                Text("[draft]")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fontWeight(.medium)
                Text(String(draft.prefix(50)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        } else if let preview, !preview.text.isEmpty {
            Text(String(preview.text.prefix(50)))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    // MARK: - Timestamp

    @ViewBuilder
    private var timestampView: some View {
        if let preview, !preview.timestamp.isEmpty {
            Text(SessionTimeFormatter.format(preview.timestamp))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Agent Info

struct AgentInfo {
    let label: String
    let emoji: String
    let color: Color

    static func from(_ agent: String) -> AgentInfo {
        switch agent.lowercased() {
        case "copilot": return AgentInfo(label: "Copilot", emoji: "🤖", color: .blue)
        case "claude":  return AgentInfo(label: "Claude", emoji: "🧠", color: .orange)
        case "codex":   return AgentInfo(label: "Codex", emoji: "⚡", color: .green)
        default:        return AgentInfo(label: agent.capitalized, emoji: "🔮", color: .purple)
        }
    }
}

// MARK: - Time Formatting

/// Mirrors web `sessionTime()` — shows HH:mm if today, "yesterday", or "Xd ago".
enum SessionTimeFormatter {
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFallback: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    static func format(_ iso: String) -> String {
        guard let date = isoFormatter.date(from: iso)
                ?? isoFallback.date(from: iso) else {
            return ""
        }

        let now = Date()
        let calendar = Calendar.current

        if calendar.isDateInToday(date) {
            return timeFormatter.string(from: date)
        }
        if calendar.isDateInYesterday(date) {
            return "yesterday"
        }

        let days = calendar.dateComponents([.day], from: date, to: now).day ?? 0
        return "\(max(days, 1))d ago"
    }
}

#endif
