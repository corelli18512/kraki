#if os(iOS)
/// SessionCardView — A single session row in the list.
///
/// Mirrors SessionCard.tsx mobile appearance:
/// - HStack with avatar (badge + unread dot), center text (title, device, preview), timestamp.

import SwiftUI

struct SessionCardView: View {
    @Environment(AppState.self) private var appState

    /// Session id only — the actual `SessionInfo` is re-fetched from
    /// the observable store on every render via the inner
    /// `SessionCardBody`. Earlier versions captured the SessionInfo
    /// struct by value at construction, which froze it and missed
    /// in-place store updates (unread / readSeq / activity).
    let sessionId: String

    var body: some View {
        // Reading `sessions[sessionId]` here registers a dependency on
        // the @Observable dict, so any mutation triggers a fresh look-up
        // and re-creation of the inner body with the new struct.
        if let session = appState.sessionStore.sessions[sessionId] {
            SessionCardBody(session: session)
                .environment(appState)
        }
    }
}

/// Inner view that owns the actual card layout. Takes a non-optional
/// `SessionInfo` so all the existing read sites stay simple. The outer
/// `SessionCardView` is responsible for keeping this struct fresh.
private struct SessionCardBody: View {
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

    /// True when the device is online but we haven't received a fresh
    /// `device_greeting` in the current connection session. Mirrors
    /// the web app's amber "connecting" state. Tracked by
    /// `DeviceStore.pendingGreetingIds` rather than checking
    /// `deviceModels.isEmpty` so the model picker can keep showing
    /// cached models across a reconnect without polluting the dot
    /// color.
    private var isDeviceConnecting: Bool {
        guard isDeviceOnline else { return false }
        return deviceStore.pendingGreetingIds.contains(session.deviceId)
    }

    private var machineName: String? {
        let name = session.deviceName.isEmpty ? device?.name : session.deviceName
        return name?.isEmpty == true ? nil : name
    }

    private var unreadCount: Int {
        if sessionStore.activeSessionId == session.id { return 0 }
        // Unread is seq-derived now (replaces the old unreadCounts dict).
        return max(0, session.lastSeq - session.readSeq)
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
        HStack(alignment: .top, spacing: 12) {
            avatarView
                .padding(.top, 3)
            centerContent
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    // MARK: - Avatar

    private var avatarView: some View {
        // Avatar carries pending-prompt affordances on its corners:
        //   • bottom-right → permission shield (amber)
        //   • top-right    → question glyph (brand), else the
        //                    active-turn spinner
        // The unread red dot lives row-end on the device pill row.
        AgentAvatar(
            agent: session.agent,
            sessionId: session.id,
            size: .md,
            status: session.state,
            pendingPermission: hasPendingPermission,
            pendingQuestion: hasPendingQuestion
        )
    }

    private var hasPendingPermission: Bool {
        preview?.type == "permission"
    }

    private var hasPendingQuestion: Bool {
        preview?.type == "question"
    }

    // MARK: - Center Content

    private var centerContent: some View {
        VStack(alignment: .leading, spacing: 5) {
            // Title row: title, optional offline pill, then timestamp
            // right-aligned. Timestamp lives here so it's anchored to
            // the headline that the user scans first.
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(session.displayTitle)
                    .font(.system(size: 18, weight: .semibold))
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

            // Device + model + pin row, with an unread red dot
            // right-aligned at the end. Replaces the old top-right
            // avatar dot — easier to associate with the row and lets
            // the avatar carry the active-turn spinner cleanly.
            HStack(spacing: 4) {
                if let name = machineName {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(deviceStatusColor)
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

                Spacer(minLength: 0)

                if isUnread {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 10, height: 10)
                }
            }

            // Preview / draft / active-tool row.
            // Reserve a fixed height so transitions between the
            // active-state activity row and the static preview don't
            // shift the card layout. Add a bit of top padding so the
            // row sits visually centered between the device-tag row
            // above and the next session's divider below.
            activityOrPreview
                .frame(height: 22, alignment: .center)
                .padding(.top, 2)
        }
    }

    /// When the session is active, show the activity row (tool chip
    /// or last user prompt). While a permission or question is pending
    /// the row falls through to the standard preview line — the avatar
    /// carries the shield / question affordance, and the preview text
    /// now reads as the description of what's being asked.
    @ViewBuilder
    private var activityOrPreview: some View {
        if session.state == .compacting && !hasPendingPermission && !hasPendingQuestion {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                    .tint(Color(hex: 0x06B6D4))
                Text("Compacting context…")
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if session.state == .active && !hasPendingPermission && !hasPendingQuestion {
            ActivityRow(
                activity: session.activity,
                lastUserMessage: appState.messageProvider?.lastUserMessageContent(session.id)
            )
        } else {
            previewText
        }
    }

    /// Color of the device tag's status dot. Driven purely by the
    /// device's own connectivity (no session.state mixing):
    ///   - device offline → gray
    ///   - device online but no greeting yet → amber (connecting)
    ///   - device online + greeting received → green
    ///
    /// Crucially this does NOT key off `appState.isFullyOnline` —
    /// during a mid-session reconnect we keep showing the last-known
    /// per-device state instead of flashing every dot amber. The
    /// cached `deviceModels` survives the reconnect, so a previously-
    /// green device stays green through the gap; `auth_ok` then
    /// refreshes the online flags and any genuinely-changed devices
    /// flip naturally. Brand-new devices first seen post-reconnect
    /// (no cached models) legitimately go amber until their
    /// `device_greeting` arrives.
    private var deviceStatusColor: Color {
        if !isDeviceOnline { return .gray }
        if isDeviceConnecting { return Color(hex: 0xFBBF24) }
        return .green
    }

    @ViewBuilder
    private var previewText: some View {
        if let draft, !isActiveSession {
            HStack(spacing: 2) {
                Text("[draft]")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fontWeight(.medium)
                Text(draft)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
        } else if let preview, !preview.text.isEmpty {
            if preview.type == "session_created" {
                // Banner-style placeholder for fresh sessions with no
                // user activity yet. Italic + tertiary tone.
                Text(preview.text)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .italic()
            } else {
                HStack(spacing: 4) {
                    if let icon = previewLeadingIcon(for: preview.type) {
                        LucideIcon(icon.glyph, size: icon.size, strokeWidth: 2, color: icon.color)
                    }
                    Text(preview.text.collapseWhitespace())
                        .font(.footnote)
                        .foregroundStyle(previewTextColor(for: preview.type))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        } else {
            // Defensive fallback (no preview record at all): match the
            // banner style so empty-state height matches other cards.
            Text("Session created")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .italic()
        }
    }

    /// Inline icon (with intended tint + size) for special preview
    /// types. Permission and question signals live on the avatar
    /// corners now, so the only special leading-icon left is `error`.
    private func previewLeadingIcon(for type: String) -> (glyph: LucideIconType, color: Color, size: CGFloat)? {
        switch type {
        case "error":
            return (.circleSlash, .red, 11)
        default:
            return nil
        }
    }

    /// Colour used for the preview body text. Errors get a red tint
    /// on the icon only — body text stays in the standard secondary
    /// tone so the card doesn't read as alarming.
    private func previewTextColor(for type: String) -> Color {
        .secondary
    }

    // MARK: - Timestamp

    @ViewBuilder
    private var timestampView: some View {
        // Prefer the preview's timestamp (last-activity time) for
        // sessions with real traffic. Fall back to `session.createdAt`
        // so a freshly-created session still shows a timestamp after
        // a cold relaunch — the in-memory `session_created` preview
        // doesn't survive process restart, but `createdAt` does
        // (it's part of the persisted `SessionDigest`).
        let timestampString = displayTimestampString()
        if !timestampString.isEmpty {
            Text(SessionTimeFormatter.format(timestampString))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func displayTimestampString() -> String {
        if let preview, !preview.timestamp.isEmpty { return preview.timestamp }
        return ISO8601.withFractional.string(from: session.createdAt)
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
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    static func format(_ iso: String) -> String {
        guard let date = ISO8601.parse(iso) else { return "" }

        let now = Date()
        let calendar = Calendar.current

        if calendar.isDateInToday(date) {
            return timeFormatter.string(from: date)
        }
        if calendar.isDateInYesterday(date) {
            return "yesterday"
        }

        // By this point the date is at least 2 calendar days old, so
        // clamp the day count to 2 — `dateComponents([.day])` returns
        // 1 for some dates that fall just before yesterday's
        // calendar boundary, which would otherwise produce "1d ago"
        // overlapping with "yesterday".
        let days = calendar.dateComponents([.day], from: date, to: now).day ?? 0
        return "\(max(days, 2))d ago"
    }
}

#endif
