#if os(iOS)
import SwiftUI

@main
struct KrakiApp: App {
    @State private var appState = AppState()
    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .preferredColorScheme(selectedScheme.colorScheme)
                #if DEBUG
                .onAppear {
                    // Auto-connect to local relay for dev
                    if appState.connectionStatus == .awaitingLogin {
                        appState.devConnect()
                    }
                }
                #endif
        }
    }
}
#endif
