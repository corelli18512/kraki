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
    @Environment(\.dismiss) private var dismiss

    let sessionId: String

    @State private var showInfoSheet = false
    /// Tracks whether we've ever observed a live `SessionInfo` for
    /// this id. Used to distinguish the brand-new pending state
    /// (session never loaded yet) from a delete-after-load (session
    /// was loaded, then went away). Only the latter pops back to
    /// the session list.
    @State private var didLoadSessionOnce = false

    private var sessionStore: SessionStore { appState.sessionStore }

    private var session: SessionInfo? {
        sessionStore.sessions[sessionId]
    }

    var body: some View {
        Group {
            if let session {
                sessionContent(session)
            } else if sessionStore.isPending(sessionId) {
                pendingView
            } else {
                notFoundView
            }
        }
        // Hide the tab bar across all branches — pending placeholder,
        // not-found, and the live chat — so the optimistic landing
        // from "Create Session" doesn't briefly show the tab bar
        // before the real session arrives.
        .hidesTabBar()
        .onAppear {
            KLog.chat("👆 [2/history TAP] session=\(sessionId.prefix(12)) — entering ChatView")
            sessionStore.activeSessionId = sessionId
            // A cached live card is never authoritative across page entry. The
            // matching subscription ACK will replace it before live frames are
            // accepted; persistent spine remains independently visible/loading.
            appState.messageStore.clearCard(sessionId)
            appState.sessionSubscriptionController.setDesired(sessionId)
            // Bootstrap the in-memory window from the DB so ChatView
            // has something to render before the (possibly delayed)
            // tentacle replay lands. Cold-launch idempotent.
            appState.messageProvider?.openSession(sessionId)
            // Ensure tentacle's view of the latest turn(s) is loaded —
            // no-op if warm-up already covered this session or if the
            // disk cache already reaches head.
            appState.messageProvider?.ensureLoaded(sessionId: sessionId, reason: "openSession")
            // Snapshot unread state SYNCHRONOUSLY (before scheduling any
            // Task) so ChatView's R3 entry-scroll sees the original value
            // even though markRead's Task may run before ChatView's .task
            // body fires.
            sessionStore.entryUnreadSnapshots[sessionId] = sessionStore.isUnread(sessionId)
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
            // SwiftUI may deliver A.onDisappear before B.onAppear during a
            // detail-to-detail navigation transition. Defer null one runloop so
            // B can atomically replace A on the same Tentacle instead of
            // emitting A→null→B. A real return to the list remains nil.
            Task { @MainActor in
                await Task.yield()
                if sessionStore.activeSessionId == nil,
                   appState.sessionSubscriptionController.desiredSessionId == sessionId {
                    appState.sessionSubscriptionController.setDesired(nil)
                }
            }
            // Drop pending bookkeeping when the user backs out of an
            // optimistic placeholder; the request stays in flight, but
            // we won't bring them back to a stale spinner if they
            // navigate forward again.
            if sessionStore.isPending(sessionId) {
                sessionStore.removePendingSession(sessionId)
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                markReadIfFocused()
            }
        }
        // Track whether the session has ever been live for this view.
        // Combined with the `session == nil && !isPending` check, this
        // detects deletion (loaded → gone) and pops back to the
        // session list.
        .onChange(of: session?.id) { _, newId in
            if newId != nil {
                didLoadSessionOnce = true
            } else if didLoadSessionOnce, !sessionStore.isPending(sessionId) {
                dismiss()
            }
        }
    }

    // MARK: - Session Content

    private func sessionContent(_ session: SessionInfo) -> some View {
        ChatView(sessionId: sessionId)
            .navigationBarTitleDisplayMode(.inline)
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
                    .accessibilityLabel("More")
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

    // MARK: - Pending placeholder
    //
    // Shown while we've sent create_session / fork_session /
    // import_session and are still awaiting the server-side
    // session_created envelope. Mirrors the web client's
    // "Starting session…" route at packages/arm/web/src/pages/SessionPage.tsx.

    @ViewBuilder
    private var pendingView: some View {
        // Render inside the normal navigation chrome so the chat view
        // slides in seamlessly when the real session id replaces this
        // route.
        VStack(spacing: 16) {
            if let reason = sessionStore.pendingSessionErrors[sessionId] {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 32))
                    .foregroundStyle(.red)
                Text("Couldn't start session")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(.primary)
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            } else {
                ProgressView()
                    .controlSize(.large)
                    .tint(.krakiPrimary)
                Text("Starting session…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationBarTitleDisplayMode(.inline)
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
        // markRead via the seq pipeline replaces the old clearUnread call.
        sessionStore.markRead(sessionId, seq: session.lastSeq)
        appState.commandSender?.markRead(sessionId: sessionId, seq: session.lastSeq)
    }
}

#endif
