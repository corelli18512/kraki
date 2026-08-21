#if os(iOS)
import SwiftUI

@main
struct KrakiApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var appState: AppState
    @State private var launchCoordinator = IOSLaunchCoordinator()
    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system
    @Environment(\.scenePhase) private var scenePhase
    private let alignmentPreviewEnabled: Bool
    private let clientAlignmentPreviewEnabled: Bool

    init() {
        #if DEBUG
        let alignmentPreviewEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_CHAT_ALIGNMENT_PREVIEW"] == "1"
        let clientAlignmentPreviewEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_CLIENT_ALIGNMENT_PREVIEW"] == "1"
        self.alignmentPreviewEnabled = alignmentPreviewEnabled
        self.clientAlignmentPreviewEnabled = clientAlignmentPreviewEnabled
        _appState = State(initialValue: alignmentPreviewEnabled || clientAlignmentPreviewEnabled
            ? IOSChatAlignmentPreviewFixture.makeAppState()
            : AppState())
        #else
        self.alignmentPreviewEnabled = false
        self.clientAlignmentPreviewEnabled = false
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
                } else if clientAlignmentPreviewEnabled {
                    IOSClientAlignmentPreview()
                } else {
                    RootView(launchCoordinator: launchCoordinator)
                        .onAppear {
                            // Wire PushManager so AppDelegate (no SwiftUI env) can reach it.
                            AppDelegate.pushManager = appState.pushManager
                            Task { await appState.pushManager?.refreshPermissionStatus() }
                            // RootView's process-scoped launch coordinator owns
                            // the initial connect so network/auth work starts
                            // behind the in-app launch gate exactly once.
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
                                appState.handleInactive()
                            @unknown default:
                                break
                            }
                        }
                }
                #else
                RootView(launchCoordinator: launchCoordinator)
                    .onAppear {
                        AppDelegate.pushManager = appState.pushManager
                        Task { await appState.pushManager?.refreshPermissionStatus() }
                        // RootView starts the first connection behind the
                        // process-scoped launch gate.
                    }
                    .onChange(of: scenePhase) {
                        switch scenePhase {
                        case .active: appState.handleForegroundRehydrate()
                        case .background: appState.handleBackground()
                        case .inactive: appState.handleInactive()
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
