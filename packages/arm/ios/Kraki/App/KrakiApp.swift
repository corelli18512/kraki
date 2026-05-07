#if os(iOS)
import SwiftUI

@main
struct KrakiApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var appState = AppState()
    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system

    init() {
        UIScrollView.appearance().showsVerticalScrollIndicator = false
        UIScrollView.appearance().showsHorizontalScrollIndicator = false
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .preferredColorScheme(selectedScheme.colorScheme)
                .onAppear {
                    // Wire PushManager so AppDelegate (no SwiftUI env) can reach it.
                    AppDelegate.pushManager = appState.pushManager
                    Task { await appState.pushManager?.refreshPermissionStatus() }

                    #if DEBUG
                    // Auto-connect to local relay for dev
                    if appState.connectionStatus == .awaitingLogin {
                        appState.devConnect()
                    }
                    #endif
                }
        }
    }
}
#endif
