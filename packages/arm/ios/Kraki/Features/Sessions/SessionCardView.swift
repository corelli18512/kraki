#if os(iOS)
/// SessionCardView — shared Session Card semantics with an iOS-native row.
///
/// Geometry is intentionally fixed to the same three information rows as the
/// macOS Sidebar: title/time, device/model, and digest preview. UIKit owns list
/// virtualization; this view owns only the row contents.

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
            draft: appState.sessionStore.drafts[session.id]
        )
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AgentAvatar(
                agent: session.agent,
                model: session.model,
                sessionId: session.id,
                size: .md
            )
            .padding(.top, 2)

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
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(projection.title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.textTitle)
                .lineLimit(1)

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

            if !projection.timeLabel.isEmpty {
                Text(projection.timeLabel)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var metadataRow: some View {
        HStack(spacing: 5) {
            if let machineName = projection.machineName {
                Text(machineName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            if projection.machineName != nil,
               let model = projection.model,
               !model.isEmpty {
                Circle()
                    .fill(Color.borderPrimary)
                    .frame(width: 3, height: 3)
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
            SessionCardStatusGlyph(status: projection.status)
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

            if projection.isUnread {
                Circle()
                    .fill(Color.red)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Unread")
            }
        }
    }
}
#endif
