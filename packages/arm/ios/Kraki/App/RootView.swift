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

            // We show the LoginView only during the very first auth
            // flow. Once we've reached `.connected` at least once, mid-
            // session reconnects (.connecting / .authenticating / etc.)
            // stay inside MainTabView — the brand header surfaces the
            // status ambiently rather than blocking the whole screen.
            if appState.hasCompletedInitialConnect {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut(duration: 0.3), value: appState.hasCompletedInitialConnect)
    }
}

#endif
