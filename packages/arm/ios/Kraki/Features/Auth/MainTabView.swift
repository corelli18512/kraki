#if os(iOS)
import SwiftUI

/// Root tab bar — mirrors the web Sidebar's mobile navigation tabs.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var sessionPath = NavigationPath()
    @State private var selectedTab: Int = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack(path: $sessionPath) {
                SessionListView(navigationPath: $sessionPath)
                    .navigationDestination(for: SessionNavID.self) { nav in
                        SessionDetailView(sessionId: nav.id)
                            .environment(appState)
                    }
            }
            .tag(0)
            .tabItem {
                Label {
                    Text("Sessions")
                } icon: {
                    LucideIconType.botMessageSquare.tabImage()
                }
            }
            .badge(appState.sessionStore.totalUnread)

            NavigationStack {
                DeviceListView()
            }
            .tag(1)
            .tabItem {
                Label {
                    Text("Devices")
                } icon: {
                    LucideIconType.monitorCloud.tabImage()
                }
            }

            NavigationStack {
                SettingsView()
            }
            .tag(2)
            .tabItem {
                Label {
                    Text("Settings")
                } icon: {
                    LucideIconType.userCog.tabImage()
                }
            }
        }
        .tint(.krakiPrimary)
        .onChange(of: appState.sessionStore.navigateToSession) { _, target in
            guard let target else { return }
            // Switch to Sessions tab and push the requested session detail.
            selectedTab = 0
            sessionPath = NavigationPath()
            sessionPath.append(SessionNavID(id: target))
            // Clear so it can fire again next time.
            appState.sessionStore.navigateToSession = nil
        }
    }
}

#endif
