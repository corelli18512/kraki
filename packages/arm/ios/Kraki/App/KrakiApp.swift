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
    private let visibleScrollScenarioEnabled: Bool
    private let newSessionScenarioEnabled: Bool
    #if DEBUG
    private let voiceHoldScenarioEnabled: Bool
    #endif

    init() {
        #if DEBUG
        let alignmentPreviewEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_CHAT_ALIGNMENT_PREVIEW"] == "1"
        let clientAlignmentPreviewEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_CLIENT_ALIGNMENT_PREVIEW"] == "1"
        let visibleScrollScenarioEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_VISIBLE_SCROLL_SCENARIO"] == "1"
        let newSessionScenarioEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_NEW_SESSION_SCENARIO"] == "1"
        self.newSessionScenarioEnabled = newSessionScenarioEnabled
        self.alignmentPreviewEnabled = alignmentPreviewEnabled
        self.clientAlignmentPreviewEnabled = clientAlignmentPreviewEnabled
        self.visibleScrollScenarioEnabled = visibleScrollScenarioEnabled
        let voiceHoldScenarioEnabled = ProcessInfo.processInfo.environment["KRAKI_IOS_VOICE_HOLD_SCENARIO"] == "1"
        self.voiceHoldScenarioEnabled = voiceHoldScenarioEnabled
        _appState = State(initialValue: voiceHoldScenarioEnabled
            ? IOSVoiceHoldScenarioFixture.makeAppState()
            : newSessionScenarioEnabled
            ? IOSNewSessionScenario.makeAppState()
            : visibleScrollScenarioEnabled
            ? IOSChatScrollScenarioFixture.makeAppState()
            : alignmentPreviewEnabled || clientAlignmentPreviewEnabled
                ? IOSChatAlignmentPreviewFixture.makeAppState()
                : NativeTestRuntime.isRunningTests ? AppState.makeUnitTestHost() : AppState())
        #else
        self.alignmentPreviewEnabled = false
        self.clientAlignmentPreviewEnabled = false
        self.visibleScrollScenarioEnabled = false
        self.newSessionScenarioEnabled = false
        _appState = State(initialValue: AppState())
        #endif
        TKMarkdown.prewarmSyntaxHighlighter()
        UIScrollView.appearance().showsVerticalScrollIndicator = false
        UIScrollView.appearance().showsHorizontalScrollIndicator = false
    }

    private var effectiveColorScheme: ColorScheme? {
        #if DEBUG
        if voiceHoldScenarioEnabled, ProcessInfo.processInfo.environment["KRAKI_VOICE_TEST_DARK"] == "1" { return .dark }
        #endif
        return selectedScheme.colorScheme
    }

    private var pairingPromptTitle: String {
        switch appState.pendingPairingPrompt {
        case .confirmRelay: return "Connect to a Self-Hosted Server?"
        case .alreadyConnected: return "Already Connected"
        case nil: return ""
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if voiceHoldScenarioEnabled {
                    IOSVoiceHoldScenarioView()
                        // Same lifecycle handling as the production root, so
                        // background/foreground behaviour is exercised for real.
                        .onChange(of: scenePhase) {
                            switch scenePhase {
                            case .active: appState.handleForegroundRehydrate()
                            case .background: appState.handleBackground()
                            case .inactive: appState.handleInactive()
                            @unknown default: break
                            }
                        }
                } else if newSessionScenarioEnabled {
                    IOSNewSessionScenarioView()
                } else if visibleScrollScenarioEnabled {
                    IOSChatScrollScenarioView()
                } else if alignmentPreviewEnabled {
                    IOSChatAlignmentPreview()
                } else if clientAlignmentPreviewEnabled {
                    IOSClientAlignmentPreview()
                } else if NativeTestRuntime.isRunningTests {
                    Color.clear
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
            .preferredColorScheme(effectiveColorScheme)
            // Pairing QR scanned with the iPhone Camera (universal link) or
            // any other way the app is opened with a pairing URL.
            .onOpenURL { url in
                if let link = PairingLink(url: url) { appState.openPairingLink(link) }
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL, let link = PairingLink(url: url) {
                    appState.openPairingLink(link)
                }
            }
            .alert(
                "Computer Key Changed",
                isPresented: Binding(
                    get: { appState.keyWarning != nil && appState.pendingPairingPrompt == nil },
                    set: { if !$0, let ids = appState.keyWarning?.ids { appState.acknowledgedKeyWarnings.formUnion(ids) } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(appState.keyWarning?.message ?? "")
            }
            .alert(
                pairingPromptTitle,
                isPresented: Binding(
                    get: { appState.pendingPairingPrompt != nil },
                    set: { if !$0 { appState.pendingPairingPrompt = nil } }
                ),
                presenting: appState.pendingPairingPrompt
            ) { prompt in
                switch prompt {
                case .confirmRelay(let link):
                    Button("Connect") { appState.openPairingLink(link, relayConfirmed: true) }
                    Button("Cancel", role: .cancel) { appState.pendingPairingPrompt = nil }
                case .alreadyConnected(let link, _):
                    Button("Log Out and Connect", role: .destructive) { appState.logoutAndPair(link) }
                    Button("Keep Current", role: .cancel) { appState.pendingPairingPrompt = nil }
                }
            } message: { prompt in
                switch prompt {
                case .confirmRelay(let link):
                    Text("This code connects to \(link.relayHost), which is not a Kraki server. Continue only if you set up this server yourself.")
                case .alreadyConnected(_, let login):
                    Text(login.map { "This iPhone is already connected as \($0). To connect a different account, log out first." }
                        ?? "This iPhone is already connected. To connect a different account, log out first.")
                }
            }
        }
    }
}
#endif
