/// PreferencesWindow — Settings scene root (⌘,).
///
/// Tabs:
///   General        — appearance, window close-to-menubar
///   Account        — login state, logout
///   Notifications  — toggle + system settings deeplink
///   Tentacle       — install state, daemon control, log path, autostart
///   Devices        — paired devices, revoke (placeholder for now)
///   About          — version, links

#if os(macOS)
import SwiftUI

struct PreferencesWindow: View {
    var body: some View {
        TabView {
            GeneralPane()
                .tabItem { Label("General", systemImage: "gearshape") }
            AccountPane()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
            NotificationsPane()
                .tabItem { Label("Notifications", systemImage: "bell") }
            TentaclePane()
                .tabItem { Label("Tentacle", systemImage: "terminal") }
            DevicesPane()
                .tabItem { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
            AboutPane()
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .scenePadding()
    }
}

#endif
