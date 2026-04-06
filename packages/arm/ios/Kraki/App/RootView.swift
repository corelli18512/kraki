#if os(iOS)
import SwiftUI

/// Root coordinator: shows login or main tab bar depending on connection state.
struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ZStack {
            switch appState.connectionStatus {
            case .connected:
                MainTabView()
            case .awaitingLogin:
                LoginView()
            case .connecting, .authenticating:
                LoginView()
                    .overlay {
                        ConnectionOverlayView(status: appState.connectionStatus)
                    }
            case .disconnected:
                MainTabView()
                    .overlay {
                        ConnectionOverlayView(status: appState.connectionStatus)
                    }
            case .error:
                MainTabView()
                    .overlay {
                        ConnectionOverlayView(status: appState.connectionStatus)
                    }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: appState.connectionStatus)
    }
}

#endif
