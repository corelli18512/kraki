#if os(iOS)
import SwiftUI

/// Root coordinator: shows login or main tab bar depending on connection state.
struct RootView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            // Background matching web: white in light, slate-950 (#020617) in dark
            Color.surfacePrimary
                .ignoresSafeArea()

            // Show MainTabView when we have valid credentials —
            // either loaded from disk at launch (returning user) or
            // freshly written by AuthManager.handleAuthOk (post sign-
            // in). `clearStoredCredentials()` flips this back to
            // false on sign-out or credential rejection, re-routing
            // to LoginView with no extra state to reconcile.
            //
            // `hasCompletedInitialConnect` is a separate concern (it
            // gates the brand-header reconnect spinner inside
            // MainTabView) and intentionally NOT part of this gate —
            // mixing them would leave the user stuck on MainTabView
            // after a credential rejection.
            #if DEBUG
            if ProcessInfo.processInfo.environment["KRAKI_AVATAR_TEST"] == "1" {
                AvatarTestView()
            } else if ProcessInfo.processInfo.environment["KRAKI_BUBBLE_CATALOG"] == "1" {
                BubbleCatalogTestView()
            } else if ProcessInfo.processInfo.environment["KRAKI_FLATBUBBLE"] == "1" {
                FlatBubbleTestView()
            } else if ProcessInfo.processInfo.environment["KRAKI_LIVEBUBBLE"] == "1" {
                // Debug shortcut: the pure-spine LIVE bubble (card) render demo,
                // mock-driven so it validates on a simulator with WS locked.
                NavigationStack { LiveBubbleTestView() }
            } else if appState.hasStoredCredentials {
                MainTabView()
            } else {
                LoginView()
            }
            #else
            if appState.hasStoredCredentials {
                MainTabView()
            } else {
                LoginView()
            }
            #endif
        }
        .animation(.easeInOut(duration: 0.3), value: appState.hasStoredCredentials)
    }
}

#endif
