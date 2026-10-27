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
    /// Two-column layout: the Mac sidebar row geometry (small avatar, 10 pt
    /// gap). Text keeps the iOS sizes.
    var sidebar = false

    var body: some View {
        if let session = appState.sessionStore.sessions[sessionId]
            ?? appState.sessionStore.archivedSessionInfo(sessionId) {
            SessionCardBody(session: session, sidebar: sidebar)
                .environment(appState)
        }
    }
}

private struct SessionCardBody: View {
    @Environment(AppState.self) private var appState
    let session: SessionInfo
    var sidebar = false

    private var projection: SessionCardProjection {
        SessionCardProjection.make(
            session: session,
            device: appState.deviceStore.devices[session.deviceId],
            preview: appState.sessionStore.sessionPreviews[session.id]
                ?? appState.sessionStore.archivedPreview(session.id),
            draft: appState.sessionStore.drafts[session.id],
            isCompacting: {
                if case .compacting = appState.messageStore.runtimeStatus(session.id) { return true }
                return false
            }(),
            pendingInputs: appState.commandSender?.pendingInputs(session.id) ?? [],
            isDeliveryOnline: appState.isFullyOnline,
            modelName: appState.deviceStore.modelDisplayName(session.model, deviceId: session.deviceId, agent: session.agent)
        )
    }

    /// Row heights that grow with the text size setting (Dynamic Type) and
    /// are exactly 20 / 18 pt at the default size.
    @ScaledMetric(relativeTo: .body) private var titleRowHeight: CGFloat = 20
    @ScaledMetric(relativeTo: .footnote) private var lineRowHeight: CGFloat = 18

    private var deviceStatusColor: Color {
        guard projection.deviceOnline == true else { return .gray }
        if appState.deviceStore.pendingGreetingIds.contains(session.deviceId) {
            return Color(hex: 0xFBBF24)
        }
        return Color(hex: 0x34D399)
    }

    /// Same name as the chat header, Mac and web ("New Session" when untitled).
    private var cardTitle: String { session.displayTitle }

    var body: some View {
        HStack(alignment: .top, spacing: sidebar ? 10 : 12) {
            AgentAvatar(
                agent: session.agent,
                model: session.model,
                sessionId: session.id,
                size: sidebar ? .sm : .lg
            )
            .padding(.top, sidebar ? 2 : 3)

            VStack(alignment: .leading, spacing: 2) {
                titleRow
                    .frame(height: titleRowHeight)
                metadataRow
                    .frame(minHeight: lineRowHeight)
                previewRow
                    .frame(height: lineRowHeight)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, sidebar ? 0 : 2)
        .contentShape(Rectangle())
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(cardTitle)
                .scaledFont(18, weight: .semibold)
                .foregroundStyle(Color.textTitle)
                .lineLimit(1)
                .truncationMode(.tail)

            if projection.deviceOnline == false {
                Text("offline")
                    .scaledFont(9, weight: .medium)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }

            if projection.isPinned {
                Image(systemName: "pin.fill")
                    .scaledFont(8, weight: .bold)
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
        SessionCardMetadataRow(machineName: projection.machineName, model: projection.model,
                               effort: projection.effortLabel, sessionId: session.id,
                               font: .caption, deviceColor: .secondary, modelColor: Color(.tertiaryLabel),
                               statusColor: sidebar ? nil : deviceStatusColor)
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
                    .foregroundStyle(Color.sessionPreviewText)
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([projection.status.accessibilityLabel, projection.previewText].compactMap { $0 }.joined(separator: ": "))
    }
}
#endif
