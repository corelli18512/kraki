#if os(iOS)
import SwiftUI

/// Root tab bar — mirrors the web Sidebar's mobile navigation tabs.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var sessionPath = NavigationPath()

    var body: some View {
        TabView {
            NavigationStack(path: $sessionPath) {
                SessionListView(navigationPath: $sessionPath)
                    .navigationDestination(for: String.self) { sessionId in
                        let _ = print("🔴 NAV DESTINATION: \(sessionId)")
                        Text("Session: \(sessionId)")
                            .onAppear { print("🔴 TEXT APPEARED: \(sessionId)") }
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
