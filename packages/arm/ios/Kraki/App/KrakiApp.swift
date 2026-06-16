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

                    if appState.connectionStatus == .awaitingLogin {
                        // Open the WS so we can request auth_info; the
                        // server's response unlocks the GitHub OAuth
                        // button on the login screen. No credentials
                        // are sent here — `bootstrapAuth` decides what
                        // to do once the socket is up. Debug builds get
                        // the same prod-default; the "Dev Login
                        // (localhost)" button on LoginView is the
                        // explicit opt-in path to the local relay.
                        appState.connect()
                    }
                }
                .onChange(of: scenePhase) {
                    switch scenePhase {
                    case .active:
                        // On every return-to-foreground, kick a fresh
                        // connect with reset backoff so the user doesn't
                        // wait out a stale 30s timer that started while
                        // backgrounded. No-op if we're already connected.
                        appState.handleForegroundRehydrate()
                    case .background:
                        // Explicitly close the WS so the relay marks this
                        // device offline immediately. Otherwise the relay
                        // would skip APNs for ~30s while it waits for a
                        // pong, opening a window where backgrounded users
                        // miss notifications.
                        appState.handleBackground()
                    case .inactive:
                        break
                    @unknown default:
                        break
                    }
                }
        }
    }
}
#endif
