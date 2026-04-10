#if os(iOS)
/// SessionDetailView — Main session view container.
///
/// Mirrors SessionPage.tsx:
/// - Toolbar with avatar, title, model/agent subtitle
/// - Offline label + reconnecting spinner in toolbar
/// - Content: ChatView
/// - Lifecycle: set/clear activeSessionId, mark read on appear/foreground

import SwiftUI

struct SessionDetailView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase

    let sessionId: String

    @State private var showInfoSheet = false

    private var sessionStore: SessionStore { appState.sessionStore }
    private var deviceStore: DeviceStore { appState.deviceStore }

    private var session: SessionInfo? {
        sessionStore.sessions[sessionId]
    }

    private var device: DeviceSummary? {
        guard let session else { return nil }
        return deviceStore.devices[session.deviceId]
    }

    private var isDeviceOnline: Bool {
        device?.online ?? false
    }

    private var isReconnecting: Bool {
        let status = appState.connectionStatus
        return (status == .disconnected || status == .connecting) && appState.reconnectAttempt > 0
    }

    var body: some View {
        let _ = KLog.d("🖥️ SessionDetailView: sessionId=\(sessionId.prefix(12)), session=\(session != nil ? "found" : "nil")")
        Group {
            if let session {
                sessionContent(session)
            } else {
                notFoundView
            }
        }
        .onAppear {
            sessionStore.activeSessionId = sessionId
            markReadIfFocused()
        }
        .onDisappear {
            if sessionStore.activeSessionId == sessionId {
                sessionStore.activeSessionId = nil
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                markReadIfFocused()
            }
        }
    }

    // MARK: - Session Content

    private func sessionContent(_ session: SessionInfo) -> some View {
        ChatView(sessionId: sessionId)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.hidden, for: .tabBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    toolbarTitle(session)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showInfoSheet = true
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .sheet(isPresented: $showInfoSheet) {
                SessionInfoSheet(session: session)
                    .environment(appState)
            }
    }

    // MARK: - Toolbar Title

    private func toolbarTitle(_ session: SessionInfo) -> some View {
        let info = AgentInfo.from(session.agent)
        let displayTitle = session.displayTitle

        return HStack(spacing: 8) {
            ZStack {
                AgentAvatar(agent: session.agent, sessionId: session.id, size: .sm)

                if isReconnecting {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(.black.opacity(0.3))
                        .frame(width: 28, height: 28)
                    ProgressView()
                        .scaleEffect(0.5)
                        .tint(.orange)
                }
            }

            // Title + subtitle
            VStack(alignment: .leading, spacing: 0) {
                Text(displayTitle)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .lineLimit(1)

                subtitleRow(session, info: info)
            }
        }
    }

    private func subtitleRow(_ session: SessionInfo, info: AgentInfo) -> some View {
        HStack(spacing: 4) {
            if session.title != nil || session.autoTitle != nil {
                Text(info.label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                if let model = session.model {
                    Text("·")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(model)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else if let model = session.model {
                Text(model)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if !isDeviceOnline {
                Text("offline")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }

            if let name = session.deviceName.isEmpty ? nil : session.deviceName {
                Text("·")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - Not Found

    private var notFoundView: some View {
        VStack(spacing: 12) {
            Text("🤷")
                .font(.system(size: 48))
            Text("Session not found")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Helpers

    private func markReadIfFocused() {
        guard let session else { return }
        sessionStore.clearUnread(sessionId)
        appState.commandSender?.markRead(sessionId: sessionId, seq: session.lastSeq)
    }
}

#endif
