/// PreferencesWindow — Settings scene root (⌘,).
///
/// Tabs:
///   General        — appearance, window close-to-menubar
///   Account        — login state, logout
///   Voice Input    — correction, conversation context, custom words
///   Notifications  — toggle + system settings deeplink
///   Tentacle       — install state, daemon control, log path, autostart
///   Devices        — paired devices, revoke (placeholder for now)
///   About          — version, links

#if os(macOS)
import SwiftUI

enum PreferencesTab: Hashable {
    case general, account, voiceInput, notifications, thisMac, devices, about
}

/// The Settings tab. Shared so a caller can open Settings on a given tab
/// (the menu bar status row opens This Mac); otherwise Settings reopens on
/// the tab last used.
@MainActor
@Observable
final class PreferencesTabSelection {
    static let shared = PreferencesTabSelection()
    var tab: PreferencesTab = .general
}

struct PreferencesWindow: View {
    @State private var selection = PreferencesTabSelection.shared

    var body: some View {
        TabView(selection: $selection.tab) {
            GeneralPane()
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(PreferencesTab.general)
            AccountPane()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(PreferencesTab.account)
            VoiceInputPane()
                .tabItem { Label("Voice Input", systemImage: "mic") }
                .tag(PreferencesTab.voiceInput)
            NotificationsPane()
                .tabItem { Label("Notifications", systemImage: "bell") }
                .tag(PreferencesTab.notifications)
            TentaclePane()
                .tabItem { Label("This Mac", systemImage: "desktopcomputer") }
                .tag(PreferencesTab.thisMac)
            DevicesPane()
                .tabItem { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
                .tag(PreferencesTab.devices)
            AboutPane()
                .tabItem { Label("About", systemImage: "info.circle") }
                .tag(PreferencesTab.about)
        }
        // Each pane is a grouped Form that scrolls itself and brings its own
        // margins; extra padding here would inset the scroll view (and its
        // scroller) away from the window edge.
    }
}

#endif
