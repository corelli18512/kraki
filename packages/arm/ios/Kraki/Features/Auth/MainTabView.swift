#if os(iOS)
import SwiftUI

/// Root tab bar — mirrors the web Sidebar's mobile navigation tabs.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    let allowsInitialNavigation: Bool
    @State private var sessionPath = NavigationPath()
    @State private var devicePath = NavigationPath()
    @State private var selectedTab: Int = 0
    @State private var showNewSession = false

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                modernTabView
            } else {
                legacyTabView
            }
        }
        .tint(.krakiPrimary)
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet()
                .environment(appState)
        }
        .onChange(of: appState.sessionStore.navigateToSession) { _, _ in
            guard allowsInitialNavigation else { return }
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
            sessionPath = NavigationPath()
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
                    sessionPath = NavigationPath()
                    sessionPath.append(SessionNavID(id: target))
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        #endif
    }

    private func consumePendingSessionNavigation() {
        guard let target = appState.sessionStore.navigateToSession else { return }
        selectedTab = 0
        sessionPath = NavigationPath()
        sessionPath.append(SessionNavID(id: target))
        appState.sessionStore.navigateToSession = nil
    }

    private func consumePendingDeviceNavigation() {
        guard let target = appState.deviceStore.navigateToDeviceId else { return }
        // Switch to Devices and push only after launch preparation. This keeps
        // a notification-created detail hierarchy from materializing behind the
        // cold-launch gate.
        selectedTab = 1
        sessionPath = NavigationPath()
        devicePath = NavigationPath()
        devicePath.append(DeviceNavID(id: target))
        appState.deviceStore.navigateToDeviceId = nil
    }

    // MARK: - Sub-views (shared)

    private var sessionsContent: some View {
        NavigationStack(path: $sessionPath) {
            SessionListView(navigationPath: $sessionPath)
                .navigationDestination(for: SessionNavID.self) { nav in
                    SessionDetailView(sessionId: nav.id)
                        .environment(appState)
                }
        }
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
        TabView(selection: $selectedTab) {
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
        .onChange(of: selectedTab) { oldValue, newValue in
            if newValue == 3 {
                showNewSession = true
                // Snap selection back synchronously so we don't flash
                // the empty Color.clear content of the +tab. The
                // previous DispatchQueue.async approach left a one-
                // runloop window where SwiftUI rendered the +tab's
                // empty body before resetting selection.
                selectedTab = oldValue
            }
        }
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

#endif
