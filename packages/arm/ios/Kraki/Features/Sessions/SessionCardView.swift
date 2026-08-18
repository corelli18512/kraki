#if os(iOS)
/// SessionCardView — iOS-native three-row Session Card.
///
/// The row keeps the same stable information slots as the other clients:
/// title/time, device/model, and digest preview. UIKit owns list reuse;
/// this view owns only the card contents.

import SwiftUI

struct SessionCardView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String

    var body: some View {
        if let session = appState.sessionStore.sessions[sessionId] {
            SessionCardBody(session: session)
                .environment(appState)
        }
    }
}

private struct SessionCardBody: View {
    @Environment(AppState.self) private var appState
    let session: SessionInfo

    private var projection: SessionCardProjection {
        SessionCardProjection.make(
            session: session,
            device: appState.deviceStore.devices[session.deviceId],
            preview: appState.sessionStore.sessionPreviews[session.id],
            draft: appState.sessionStore.drafts[session.id],
            isCompacting: {
                if case .compacting = appState.messageStore.runtimeStatus(session.id) { return true }
                return false
            }()
        )
    }

    private var deviceStatusColor: Color {
        guard projection.deviceOnline == true else { return .gray }
        if appState.deviceStore.pendingGreetingIds.contains(session.deviceId) {
            return Color(hex: 0xFBBF24)
        }
        return Color(hex: 0x34D399)
    }

    private var cardTitle: String {
        session.title ?? session.autoTitle ?? AgentInfo.from(session.agent).label
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentAvatar(
                agent: session.agent,
                model: session.model,
                sessionId: session.id,
                size: .lg
            )
            .padding(.top, 3)

            VStack(alignment: .leading, spacing: 2) {
                titleRow
                    .frame(height: 20)
                metadataRow
                    .frame(height: 18)
                previewRow
                    .frame(height: 18)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(cardTitle)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.textTitle)
                .lineLimit(1)
                .truncationMode(.tail)

            if projection.deviceOnline == false {
                Text("offline")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }

            if projection.isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Color.krakiPrimary)
            }

            Spacer(minLength: 4)

            if projection.isUnread {
                Circle()
                    .fill(Color.red)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Unread")
            }

            if !projection.timeLabel.isEmpty {
                Text(projection.timeLabel)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    private var metadataRow: some View {
        HStack(spacing: 6) {
            if let machineName = projection.machineName {
                Circle()
                    .fill(deviceStatusColor)
                    .frame(width: 6, height: 6)

                Text(machineName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            if projection.machineName != nil,
               let model = projection.model,
               !model.isEmpty {
                Rectangle()
                    .fill(Color.borderPrimary)
                    .frame(width: 1, height: 9)
            }

            if let model = projection.model, !model.isEmpty {
                Text(model)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var previewRow: some View {
        HStack(spacing: 5) {
            SessionCardStatusGlyph(
                status: projection.status,
                hasDraft: projection.isDraft
            )
                .accessibilityLabel(projection.status.accessibilityLabel ?? "")

            if let previewText = projection.previewText {
                Text(previewText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else {
                Text("Session created")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .italic()
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
