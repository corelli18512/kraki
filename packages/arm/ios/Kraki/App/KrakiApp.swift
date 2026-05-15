#if os(iOS)
import SwiftUI

@main
struct KrakiApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var appState = AppState()
    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system
    @Environment(\.scenePhase) private var scenePhase

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
                .onChange(of: scenePhase) { _, phase in
                    // On every return-to-foreground, kick a fresh
                    // connect with reset backoff so the user doesn't
                    // wait out a stale 30s timer that started while
                    // backgrounded. No-op if we're already connected.
                    if phase == .active {
                        appState.handleForegroundRehydrate()
                    }
                }
        }
    }
}
#endif
