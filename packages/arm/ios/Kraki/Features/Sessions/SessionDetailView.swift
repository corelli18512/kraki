#if os(iOS)
/// SessionDetailView — Main session view container.
///
/// Mirrors SessionPage.tsx:
/// - Toolbar with title only
/// - Content: ChatView
/// - Lifecycle: set/clear activeSessionId, mark read on appear/foreground

import SwiftUI

struct SessionDetailView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase

    let sessionId: String

    @State private var showInfoSheet = false

    private var sessionStore: SessionStore { appState.sessionStore }

    private var session: SessionInfo? {
        sessionStore.sessions[sessionId]
    }

    var body: some View {
        Group {
            if let session {
                sessionContent(session)
            } else {
                notFoundView
            }
        }
        .onAppear {
            sessionStore.activeSessionId = sessionId
            // Snapshot unread state SYNCHRONOUSLY (before scheduling any
            // Task) so ChatView's R3 entry-scroll sees the original value
            // even though markRead's Task may run before ChatView's .task
            // body fires.
            let liveUnread = sessionStore.unreadCounts[sessionId] ?? 0
            sessionStore.entryUnreadSnapshots[sessionId] = liveUnread > 0
            // Defer markRead one runloop turn so ChatView's entry-scroll
            // task can snapshot the unread state before it's cleared.
            Task { @MainActor in
                markReadIfFocused()
            }
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
            .hidesTabBar()
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
        // While the relay channel is broken we replace the session
        // title with "Reconnecting…" so the user knows the chat is
        // currently in a stale-read state. Wording matches the
        // ambient indicator on the brand header.
        let displayTitle = appState.isReconnecting ? "Reconnecting…" : session.displayTitle

        return Text(displayTitle)
            .font(.subheadline)
            .fontWeight(.semibold)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(.easeInOut(duration: 0.2), value: appState.isReconnecting)
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
