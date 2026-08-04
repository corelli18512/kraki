#if os(iOS)
import SwiftUI

@main
struct KrakiApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var appState: AppState
    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system
    @Environment(\.scenePhase) private var scenePhase
    private let alignmentPreviewEnabled: Bool

    init() {
        #if DEBUG
        let alignmentPreviewEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_CHAT_ALIGNMENT_PREVIEW"] == "1"
        self.alignmentPreviewEnabled = alignmentPreviewEnabled
        _appState = State(initialValue: alignmentPreviewEnabled
            ? IOSChatAlignmentPreviewFixture.makeAppState()
            : AppState())
        #else
        self.alignmentPreviewEnabled = false
        _appState = State(initialValue: AppState())
        #endif
        TKMarkdown.prewarmSyntaxHighlighter()
        UIScrollView.appearance().showsVerticalScrollIndicator = false
        UIScrollView.appearance().showsHorizontalScrollIndicator = false
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if alignmentPreviewEnabled {
                    IOSChatAlignmentPreview()
                } else {
                    RootView()
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
                #else
                RootView()
                    .onAppear {
                        AppDelegate.pushManager = appState.pushManager
                        Task { await appState.pushManager?.refreshPermissionStatus() }
                        if appState.connectionStatus == .awaitingLogin { appState.connect() }
                    }
                    .onChange(of: scenePhase) {
                        switch scenePhase {
                        case .active: appState.handleForegroundRehydrate()
                        case .background: appState.handleBackground()
                        case .inactive: break
                        @unknown default: break
                        }
                    }
                #endif
            }
            .environment(appState)
            .preferredColorScheme(selectedScheme.colorScheme)
        }
    }
}
#endif
