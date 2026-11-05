#if os(iOS)
import SwiftUI

/// Root tab bar — mirrors the web Sidebar's mobile navigation tabs.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    let allowsInitialNavigation: Bool
    /// Open Sessions, oldest first. On wide windows the first one is shown
    /// beside the list (the Mac's selection) and later ones (forks) are
    /// pushed over it; on narrow windows all are pushed over the list. The
    /// same stack serves both, so a fold/unfold keeps the open chat alive.
    @State private var sessionPath: [SessionNavID] = []
    @State private var devicePath = NavigationPath()
    @State private var selectedTab: Int = 0
    @State private var showNewSession = false
    /// From presenting the New Session sheet until its dismissal finished.
    /// A Session started from it opens only then: pushed while the sheet and
    /// its keyboard were still sliding away, the new page appeared beside the
    /// keyboard and under the sheet.
    @State private var newSessionSheetOnScreen = false

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                modernTabView
            } else {
                legacyTabView
            }
        }
        .tint(.krakiPrimary)
        .overlay(alignment: .top) { SignedInErrorToast() }
        .sheet(isPresented: $showNewSession, onDismiss: {
            newSessionSheetOnScreen = false
            guard allowsInitialNavigation else { return }
            consumePendingSessionNavigation()
        }) {
            NewSessionSheet()
                .environment(appState)
                .onAppear { newSessionSheetOnScreen = true }
        }
        .onChange(of: appState.sessionStore.navigateToSession) { _, _ in
            guard allowsInitialNavigation, !newSessionSheetOnScreen else { return }
            consumePendingSessionNavigation()
        }
        .onAppear {
            // A notification can launch the process before MainTabView exists.
            // Keep it queued while the launch overlay prepares the Sessions
            // shell, then consume it only after the first stable frame.
            guard allowsInitialNavigation else { return }
            consumePendingSessionNavigation()
            consumePendingDeviceNavigation()
        }
        .onChange(of: allowsInitialNavigation) { _, allowed in
            guard allowed else { return }
            consumePendingSessionNavigation()
            consumePendingDeviceNavigation()
        }
        .onChange(of: appState.sessionStore.unreadSessionIDs, initial: true) { _, ids in
            appState.pushManager?.syncApplicationBadge(unreadSessionIDs: ids)
        }
        .onChange(of: appState.deviceStore.navigateToDeviceId) { _, _ in
            guard allowsInitialNavigation else { return }
            consumePendingDeviceNavigation()
        }
        .onChange(of: appState.sessionStore.popToSessionListSignal) { _, _ in
            // A session was deleted while the user was viewing it.
            // Pop the chat detail so they land on the session list
            // instead of a "Session not found" placeholder.
            selectedTab = 0
            sessionPath = []
        }
        #if DEBUG
        .task(id: allowsInitialNavigation) {
            guard allowsInitialNavigation,
                  let target = ProcessInfo.processInfo.environment["KRAKI_OPEN_SESSION_ID"],
                  !target.isEmpty else { return }
            // Pairing/auth and session_list are asynchronous. Wait until the
            // requested session exists, then drive the normal navigation path.
            for _ in 0..<100 {
                if appState.sessionStore.sessions[target] != nil {
                    selectedTab = 0
                    sessionPath = []
                    sessionPath.append(SessionNavID(id: target))
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        .task(id: allowsInitialNavigation) {
            // Automation: start on the Devices tab.
            guard allowsInitialNavigation, ProcessInfo.processInfo.environment["KRAKI_OPEN_DEVICES_TAB"] == "1" else { return }
            selectedTab = 1
        }
        #endif
    }

    private func consumePendingSessionNavigation() {
        guard let target = appState.sessionStore.navigateToSession else { return }
        let placeholder = appState.sessionStore.navigationReplacesPlaceholder
        let pushesOnTop = appState.sessionStore.navigationPushesOnTop
        appState.sessionStore.navigationReplacesPlaceholder = nil
        appState.sessionStore.navigationPushesOnTop = false
        appState.sessionStore.navigateToSession = nil
        let route = SessionNavigationRoute.open(
            target, in: sessionPath, replacingPlaceholder: placeholder,
            pushesOnTop: pushesOnTop, sessionsTabSelected: selectedTab == 0)
        selectedTab = 0
        guard route.inPlace else {
            sessionPath = route.path
            return
        }
        // "Starting session…" / "Copying session…" → the created Session: swap
        // the route in place, without a pop/push transition. The destination
        // is keyed by id, so the real Session's page runs its own lifecycle
        // (subscription, viewing state, read state) instead of inheriting the
        // placeholder's.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { sessionPath = route.path }
    }

    private func consumePendingDeviceNavigation() {
        guard let target = appState.deviceStore.navigateToDeviceId else { return }
        // Switch to Devices and push only after launch preparation. This keeps
        // a notification-created detail hierarchy from materializing behind the
        // cold-launch gate. The Sessions stack is kept, like a manual tab
        // switch: the chat the user came from is still there on Sessions.
        selectedTab = 1
        devicePath = NavigationPath()
        devicePath.append(DeviceNavID(id: target))
        appState.deviceStore.navigateToDeviceId = nil
    }

    // MARK: - Sub-views (shared)

    private var sessionsContent: some View {
        GeometryReader { geometry in
            let wide = SessionSplitLayout.isWide(geometry.size.width)
            HStack(spacing: 0) {
                if wide {
                    NavigationStack {
                        SessionListView(selectedSessionId: sessionPath.first?.id) { select($0) }
                    }
                    .frame(width: SessionSplitLayout.sidebarWidth)
                    .transition(.move(edge: .leading))
                    Rectangle()
                        .fill(Color.borderPrimary.opacity(0.55))
                        .frame(width: 1)
                        .ignoresSafeArea()
                }
                // Same position in both layouts: SwiftUI keeps this stack, and
                // the chat pushed on it, across a fold/unfold.
                NavigationStack(path: $sessionPath) {
                    Group {
                        if wide {
                            SessionSplitPlaceholder()
                        } else {
                            SessionListView { sessionPath.append(SessionNavID(id: $0)) }
                        }
                    }
                    .navigationDestination(for: SessionNavID.self) { nav in
                        // Identity per Session: when a route's id changes (pending
                        // placeholder → created Session) the page must disappear
                        // and appear again, not silently rebind its sessionId.
                        SessionDetailView(sessionId: nav.id)
                            .id(nav.id)
                            .environment(\.sessionSplit, SessionSplitContext(
                                active: wide, isDetailRoot: wide && sessionPath.first == nav))
                            .environment(appState)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    /// Two-column layout: show this Session beside the list (no push animation,
    /// like selecting a row in the Mac sidebar).
    private func select(_ id: String) {
        guard sessionPath != [SessionNavID(id: id)] else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { sessionPath = [SessionNavID(id: id)] }
    }

    private var devicesContent: some View {
        NavigationStack(path: $devicePath) {
            DeviceListView()
        }
    }

    private var settingsContent: some View {
        NavigationStack {
            SettingsView()
        }
    }

    // MARK: - iOS 26 TabView with separated search-role tab for +

    @available(iOS 26.0, *)
    @ViewBuilder
    private var modernTabView: some View {
        TabView(selection: tabSelection) {
            Tab(value: 0) {
                sessionsContent
            } label: {
                Label {
                    Text("Sessions")
                } icon: {
                    LucideIconType.botMessageSquare.tabImage()
                }
            }
            .badge(appState.sessionStore.totalUnread)

            Tab(value: 1) {
                devicesContent
            } label: {
                Label {
                    Text("Devices")
                } icon: {
                    LucideIconType.monitorCloud.tabImage()
                }
            }

            Tab(value: 2) {
                settingsContent
            } label: {
                Label {
                    Text("Settings")
                } icon: {
                    LucideIconType.userCog.tabImage()
                }
            }

            // Trailing "+" — uses .search role to render as a separated
            // accessory group on the right side of the tab bar (iOS 26
            // standard pattern). Tapping it opens the New Session sheet
            // and resets the tab selection.
            Tab(value: 3, role: .search) {
                Color.clear
            } label: {
                Label("New Session", systemImage: "plus")
            }
        }
        .background {
            TabActionInterceptor(actionTitle: String(localized: "New Session")) { showNewSession = true }
                .frame(width: 0, height: 0)
        }
    }

    /// The "+" tab is an action, never a destination. `TabActionInterceptor`
    /// stops UIKit from selecting it (see there for why that matters); this
    /// binding is the SwiftUI-side fallback so selection never becomes 3.
    private var tabSelection: Binding<Int> {
        Binding(
            get: { selectedTab },
            set: { newValue in
                if newValue == 3 {
                    showNewSession = true
                } else {
                    selectedTab = newValue
                }
            }
        )
    }

    // MARK: - Pre-iOS 26 fallback

    private var legacyTabView: some View {
        TabView(selection: $selectedTab) {
            sessionsContent
                .tag(0)
                .tabItem {
                    Label {
                        Text("Sessions")
                    } icon: {
                        LucideIconType.botMessageSquare.tabImage()
                    }
                }
                .badge(appState.sessionStore.totalUnread)

            devicesContent
                .tag(1)
                .tabItem {
                    Label {
                        Text("Devices")
                    } icon: {
                        LucideIconType.monitorCloud.tabImage()
                    }
                }

            settingsContent
                .tag(2)
                .tabItem {
                    Label {
                        Text("Settings")
                    } icon: {
                        LucideIconType.userCog.tabImage()
                    }
                }
        }
    }
}

/// Errors raised while signed in (`AppState.lastError`: a refused region
/// redirect, an auth outage that is being retried, a refused server command)
/// used to be rendered only on the sign-in screen, i.e. never. Show them over
/// the signed-in shell; tapping dismisses, and a newer error replaces it.
struct SignedInErrorToast: View {
    @Environment(AppState.self) private var appState
    static let visibleSeconds: Double = 8

    var body: some View {
        ZStack {
            if let message = Self.visibleMessage(appState.lastError) {
                content(message)
                    .id(message)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: message) {
                        try? await Task.sleep(for: .seconds(Self.visibleSeconds))
                        guard !Task.isCancelled else { return }
                        dismiss(message)
                    }
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: appState.lastError)
    }

    static func visibleMessage(_ lastError: String?) -> String? {
        guard let lastError, !lastError.isEmpty else { return nil }
        return lastError
    }

    /// Clears the error only if it is still the one shown.
    private func dismiss(_ message: String) {
        if appState.lastError == message { appState.lastError = nil }
    }

    private func content(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Color.primary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            .frame(maxWidth: 420)
            .padding(.top, 8)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
            .onTapGesture { dismiss(message) }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(Text("Dismiss"))
            .accessibilityIdentifier("signed-in.error")
    }
}

#endif
