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
                .padding(.top, 3)
            centerContent
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    // MARK: - Avatar

    private var avatarView: some View {
        AgentAvatar(
            agent: session.agent,
            sessionId: session.id,
            size: .md,
            status: session.state,
            badge: avatarBadge,
            unreadCount: unreadCount
        )
    }

    private var avatarBadge: AvatarBadge? {
        if let preview, preview.type == "permission" { return .permission }
        if let preview, preview.type == "question" { return .question }
        return nil
    }

    @ViewBuilder
    private var statusDot: some View {
        // When the relay channel is broken, every session's state is
        // potentially stale. Surface that as a warning-orange dot
        // regardless of the cached online flag.
        if !appState.isFullyOnline {
            Circle()
                .fill(Color(hex: 0xFBBF24))
                .frame(width: 8, height: 8)
                .overlay(
                    Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5)
                )
                .offset(x: 2, y: 2)
        } else if isDeviceOnline {
            Circle()
                .fill(session.state == .active ? Color.blue : Color.green)
                .frame(width: 8, height: 8)
                .overlay(
                    Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5)
                )
                .offset(x: 2, y: 2)
        }
    }

    // MARK: - Center Content

    private var centerContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            // Title row
            HStack(spacing: 4) {
                Text(session.displayTitle)
                    .font(.headline)
                    .foregroundStyle(Color.textTitle)
                    .lineLimit(1)

                if !isDeviceOnline {
                    Text("offline")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }

                Spacer(minLength: 0)

                timestampView
            }

            // Device + model
            HStack(spacing: 4) {
                if let name = machineName {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 6, height: 6)
                        Text(name)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.surfaceTertiary, in: Capsule())
                }

                if let model = session.model {
                    Text(model)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.surfaceTertiary, in: Capsule())
                        .lineLimit(1)
                }

                if session.pinned {
                    LucideIcon(.pin, size: 10, strokeWidth: 2.2, color: .krakiPrimary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 3)
                        .background(Color.krakiPrimary.opacity(0.12), in: Capsule())
                }
            }

            // Preview / draft
            previewText
                .padding(.top, 2)
        }
    }

    private var statusColor: Color {
        if !appState.isFullyOnline { return Color(hex: 0xFBBF24) }
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
            Text(String(preview.text.prefix(50)).collapseWhitespace())
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
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

// MARK: - Time Formatting

/// Collapse runs of whitespace/newlines into a single space.
extension String {
    func collapseWhitespace() -> String {
        self.components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

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
