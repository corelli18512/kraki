#if os(iOS)
import SwiftUI

/// Root tab bar — mirrors the web Sidebar's mobile navigation tabs.
///
/// Three tabs: Agents (sessions), Devices, and Settings.
struct MainTabView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        TabView {
            NavigationStack {
                SessionListView()
                    .navigationDestination(for: String.self) { sessionId in
                        SessionDetailView(sessionId: sessionId)
                            .environment(appState)
                    }
            }
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
            .tabItem {
                Label {
                    Text("Settings")
                } icon: {
                    LucideIconType.userCog.tabImage()
                }
            }
        }
        .tint(.krakiPrimary)
    }
}

#endif
