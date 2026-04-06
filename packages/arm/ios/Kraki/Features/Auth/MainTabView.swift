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
            }
            .tabItem {
                Label("Agents", systemImage: "bubble.left.and.bubble.right")
            }
            .badge(appState.sessionStore.totalUnread)

            NavigationStack {
                DeviceListView()
            }
            .tabItem {
                Label("Devices", systemImage: "display")
            }

            NavigationStack {
                SettingsView()
            }
            .tabItem {
                Label("Settings", systemImage: "gear")
            }
        }
    }
}

#endif
