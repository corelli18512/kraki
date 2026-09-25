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
    @State private var modePickerExpanded = HeaderModePicker.startsExpanded
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
                pageWithHeader(title: "New Session", opensInfo: false) { pendingView }
            } else {
                pageWithHeader(title: "", opensInfo: false) { notFoundView }
            }
        }
        // The Session list hides the system navigation bar and draws its own
        // header, so the chat does the same: its header is page content and
        // slides with the page. A shared UINavigationBar that is shown here
        // and hidden on the list animates its own background in and out
        // DURING an interactive swipe-back (the chat's top brightened
        // mid-gesture, and iOS 26's scroll-edge blur detached from the page).
        .toolbar(.hidden, for: .navigationBar)
        .enablesSwipeBack()
        // Hide the tab bar across all branches — pending placeholder,
        // not-found, and the live chat — so the optimistic landing
        // from "Create Session" doesn't briefly show the tab bar
        // before the real session arrives.
        .hidesTabBar()
        .onAppear {
            KLog.chat("👆 [2/history TAP] session=\(sessionId.prefix(12)) — entering ChatView")
            appState.beginViewingSession(sessionId)
            // Keep the last authoritative live card mounted during page entry.
            // openSession restores its gate from durable history (clearing a
            // card when a conclusion already landed), and the subscription ACK
            // atomically replaces it before new subscriber-only frames arrive.
            // Clearing here made an active card collapse for one network RTT.
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
            appState.endViewingSession(sessionId)
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
        // While the relay channel is broken we replace the session title with
        // "Reconnecting…" so the user knows the chat is currently in a
        // stale-read state. Wording matches the ambient indicator on the
        // brand header.
        let title = appState.isReconnecting ? "Reconnecting…" : session.displayTitle
        return pageWithHeader(title: title, opensInfo: true) {
            ChatView(sessionId: sessionId)
        }
        .sheet(isPresented: $showInfoSheet) {
            SessionInfoSheet(session: session)
                .environment(appState)
        }
    }

    // MARK: - Header (page content, not a navigation bar)

    private func pageWithHeader<Content: View>(
        title: String,
        opensInfo: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        ZStack(alignment: .top) {
            content()
            chatHeader(title: title, opensInfo: opensInfo)
        }
    }

    /// Floating back button + a Liquid Glass title capsule that hugs its text,
    /// centered in the remaining width. Tapping the title opens Session info;
    /// there is no separate "more" button.
    private func chatHeader(title: String, opensInfo: Bool) -> some View {
        if opensInfo {
            return AnyView(headerWithMode(title: title))
        }
        // Pending / not-found routes: back + title only.
        return AnyView(HStack(spacing: 10) {
            headerButton(systemName: "chevron.left", label: "Back") { dismiss() }
            ZStack {
                if !title.isEmpty {
                    titleCapsule(title, opensInfo: false)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 16)
        .frame(height: ChatHeaderMetrics.height))
    }

    /// Back · title (centered in the space between back and mode) · mode
    /// capsule, as on Mac. Expanding the mode picker replaces the title and
    /// spreads the four modes across the full width right of the back button.
    private func headerWithMode(title: String) -> some View {
        HStack(spacing: 8) {
            headerButton(systemName: "chevron.left", label: "Back") { dismiss() }
            if !modePickerExpanded {
                ZStack {
                    if !title.isEmpty {
                        titleCapsule(title, opensInfo: true)
                    }
                }
                .frame(maxWidth: .infinity)
                .transition(.opacity)
            }
            HeaderModePicker(sessionId: sessionId, expanded: $modePickerExpanded)
        }
        .padding(.horizontal, 16)
        .frame(height: ChatHeaderMetrics.height)
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: modePickerExpanded)
    }

    @ViewBuilder
    private func titleCapsule(_ title: String, opensInfo: Bool) -> some View {
        let label = Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.primary)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 16)
            .frame(height: ChatHeaderMetrics.buttonSize)
            .contentShape(Capsule())
        let button = Button { if opensInfo { showInfoSheet = true } } label: { label }
            .buttonStyle(.plain)
            .disabled(!opensInfo)
            .accessibilityAddTraits(.isHeader)
            .accessibilityHint(opensInfo ? "Shows session info" : "")
            .animation(.easeInOut(duration: 0.2), value: title)
        if #available(iOS 26.0, *) {
            button.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            button.background(.ultraThinMaterial, in: Capsule())
        }
    }

    @ViewBuilder
    private func headerButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
        let button = Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.primary)
                .frame(width: ChatHeaderMetrics.buttonSize, height: ChatHeaderMetrics.buttonSize)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        if #available(iOS 26.0, *) {
            button.glassEffect(.regular.interactive(), in: Circle())
        } else {
            button.background(.ultraThinMaterial, in: Circle())
        }
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
        guard scenePhase == .active, session != nil else { return }
        appState.markSessionReadIfVisible(sessionId)
    }
}

/// Session mode control in the chat header (mirrors the Mac chat header).
/// Collapsed: a glass capsule showing the current mode. Expanded: the four
/// modes spread across the available width; picking one collapses after a
/// short beat, and an idle expansion collapses after 3s.
struct HeaderModePicker: View {
    /// Debug-only: keep the picker expanded (for screenshots).
    static var startsExpanded: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["KRAKI_HEADER_MODE_EXPANDED"] == "1"
        #else
        false
        #endif
    }
    private static let modes: [SessionMode] = [.safe, .discuss, .execute, .delegate]

    let sessionId: String
    @Binding var expanded: Bool
    @Environment(AppState.self) private var appState
    @State private var collapseTask: Task<Void, Never>?

    private var current: SessionMode { appState.sessionStore.sessionModes[sessionId] ?? .discuss }

    var body: some View {
        if expanded {
            HStack(spacing: 2) {
                ForEach(Self.modes, id: \.self) { mode in
                    Button {
                        if mode != current {
                            UISelectionFeedbackGenerator().selectionChanged()
                            appState.commandSender?.setSessionMode(sessionId: sessionId, mode: mode)
                        }
                        collapse(after: .milliseconds(450))
                    } label: {
                        segment(mode, selected: mode == current)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(mode.rawValue.capitalized)
                    .accessibilityAddTraits(mode == current ? .isSelected : [])
                    .accessibilityIdentifier("chat.mode.\(mode.rawValue)")
                }
            }
            .padding(3)
            .frame(maxWidth: .infinity)
            .frame(height: ChatHeaderMetrics.buttonSize)
            .modifier(GlassCapsule())
            .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .trailing)))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Session mode")
        } else {
            Button {
                expanded = true
                collapse(after: .seconds(3))
            } label: {
                HStack(spacing: 6) {
                    Circle().fill(Color.modeColor(current)).frame(width: 7, height: 7)
                    Text(current.rawValue.capitalized)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.primary)
                }
                .padding(.horizontal, 14)
                .frame(height: ChatHeaderMetrics.buttonSize)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .modifier(GlassCapsule())
            .accessibilityLabel("Session mode, \(current.rawValue.capitalized)")
            .accessibilityHint("Shows the session modes")
            .accessibilityIdentifier("chat.mode.collapsed")
            .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .trailing)))
        }
    }

    private func segment(_ mode: SessionMode, selected: Bool) -> some View {
        HStack(spacing: 5) {
            Circle().fill(selected ? Color.white : Color.modeColor(mode)).frame(width: 6, height: 6)
            Text(mode.rawValue.capitalized)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(selected ? Color.white : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity)
        .frame(height: ChatHeaderMetrics.buttonSize - 6)
        .background { if selected { Capsule().fill(Color.modeColor(mode)) } }
        .contentShape(Capsule())
    }

    private func collapse(after delay: Duration) {
        guard !Self.startsExpanded else { return }
        collapseTask?.cancel()
        collapseTask = Task { @MainActor in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            expanded = false
        }
    }
}

private struct GlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content.background(.ultraThinMaterial, in: Capsule())
        }
    }
}

enum ChatHeaderMetrics {
    static let height: CGFloat = 54
    static let buttonSize: CGFloat = 44
}

#endif
