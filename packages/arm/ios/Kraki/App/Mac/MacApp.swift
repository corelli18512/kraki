/// MacApp — `@main` SwiftUI entry for the macOS target.
///
/// Window topology
/// ---------------
///   1× WindowGroup "main"      — primary chat window (single instance)
///   1× Settings scene          — Preferences window (⌘,)
///   1× WindowGroup "logs"      — Logs viewer (⌘L), secondary window
///   1× MenuBarExtra            — system menu bar status item
///
/// AppState is owned here and injected as @Environment into every scene.
/// TentacleCLIManager is also a singleton — it polls the local kraki
/// daemon's status and exposes start/stop/connect actions to the UI.

#if os(macOS)
import AppKit
import Observation
import SwiftUI

/// Process-scoped launch routing for the production Mac window.
///
/// The coordinator deliberately owns routing above MainWindowView. Once local
/// credentials resolve, it stages the authenticated shell below the launch gate
/// for one real AppKit layout pass, but keeps Session navigation queued so Chat
/// is not mounted behind the launch surface. A cold process starts with no
/// selected Session; closing and reopening the window while the menu-bar process
/// remains alive reuses `lastSelectedSessionId` instead.
@Observable
@MainActor
final class MacLaunchCoordinator {
    enum Phase: Equatable {
        case launching
        /// Credentials are resolved and the authenticated shell is mounted,
        /// but the launch gate remains above it until its first real layout.
        case preparingAuthenticated
        case authenticated
        case signedOut
    }

    private(set) var phase: Phase = .launching
    private(set) var isCheckingCredentials = false
    private(set) var loginCheckFailed = false
    var lastSelectedSessionId: String?

    var isLaunchGateVisible: Bool {
        phase == .launching || phase == .preparingAuthenticated
    }

    @ObservationIgnored private var hasStarted = false
    @ObservationIgnored private var servicesStarted = false
    @ObservationIgnored private var launchStartedAt: Date?
    @ObservationIgnored private var isFinishingAuthenticatedSurface = false
    @ObservationIgnored private var presentationWatchdogTask: Task<Void, Never>?

    func bootstrap(
        appState: AppState,
        tentacleCLI: TentacleCLIManager,
        devLocal: Bool,
        mock: Bool,
        bypassProductionLaunch: Bool
    ) async {
        guard !hasStarted else { return }
        hasStarted = true

        if bypassProductionLaunch {
            phase = .authenticated
            return
        }

        let startedAt = Date()
        launchStartedAt = startedAt
        KLog.diag("[MacLaunch] gate presented")
        if !servicesStarted {
            servicesStarted = true
            Task { @MainActor in
                await tentacleCLI.refreshInstallState()
                await tentacleCLI.refreshDaemonState()
                tentacleCLI.startPolling()
            }
        }

        #if DEBUG
        let forceSignedOut = ProcessInfo.processInfo.environment["KRAKI_MAC_FORCE_SIGNED_OUT"] == "1"
        #else
        let forceSignedOut = false
        #endif

        let canEnterAuthenticatedRoot: Bool
        if forceSignedOut {
            canEnterAuthenticatedRoot = false
        } else if devLocal {
            appState.devConnect()
            canEnterAuthenticatedRoot = true
        } else if mock {
            canEnterAuthenticatedRoot = true
        } else {
            // Keep the launch gate mounted while the app resolves its preferred
            // CLI credential. This removes the old signed-out-page flash before
            // a returning CLI user was recognised.
            let usedCLILogin = await appState.attemptCLILogin()
            if !usedCLILogin, appState.hasStoredCredentials {
                appState.connect()
            }
            canEnterAuthenticatedRoot = usedCLILogin || appState.hasStoredCredentials
        }

        guard !Task.isCancelled else {
            // Closing the only window can cancel its SwiftUI `.task` while the
            // menu-bar process stays alive. Permit the warm reopen to bootstrap
            // again instead of leaving the process permanently on Launch.
            hasStarted = false
            return
        }

        if canEnterAuthenticatedRoot {
            // Do not remove the gate and only then construct the Sidebar. Mount
            // the authenticated shell underneath it; a presentation probe will
            // remove the gate after the first AppKit-backed layout has settled.
            beginPreparingAuthenticatedSurface()
        } else {
            await waitForMinimumLaunchVisibility()
            guard !Task.isCancelled else {
                hasStarted = false
                return
            }
            phase = .signedOut
            logDestination("signedOut")
        }
    }

    func authenticatedSurfaceDidPresent() async {
        presentationWatchdogTask?.cancel()
        presentationWatchdogTask = nil
        await finishAuthenticatedSurface(source: "probe")
    }

    private func beginPreparingAuthenticatedSurface() {
        phase = .preparingAuthenticated
        presentationWatchdogTask?.cancel()
        presentationWatchdogTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self,
                  self.phase == .preparingAuthenticated else { return }
            self.presentationWatchdogTask = nil
            KLog.diag("[MacLaunch] presentation watchdog fired")
            await self.finishAuthenticatedSurface(source: "watchdog")
        }
    }

    private func finishAuthenticatedSurface(source: String) async {
        guard phase == .preparingAuthenticated,
              !isFinishingAuthenticatedSurface else { return }
        isFinishingAuthenticatedSurface = true
        defer { isFinishingAuthenticatedSurface = false }

        await waitForMinimumLaunchVisibility()
        guard !Task.isCancelled, phase == .preparingAuthenticated else { return }
        let queuedSelection = lastSelectedSessionId
        phase = .authenticated
        logDestination("authenticated source=\(source)")

        // A deep link may have arrived while only the gate existed. Keep Chat
        // unmounted during preparation, then deliver the queued navigation once
        // the authenticated shell owns a stable first frame.
        if let queuedSelection {
            await Task.yield()
            NotificationCenter.default.post(
                name: .macSelectSession,
                object: nil,
                userInfo: ["sessionId": queuedSelection]
            )
        }
    }

    private func waitForMinimumLaunchVisibility() async {
        let startedAt = launchStartedAt ?? Date()
        #if DEBUG
        let minimumVisibleSeconds = ProcessInfo.processInfo.environment["KRAKI_MAC_LAUNCH_MIN_MS"]
            .flatMap(Double.init)
            .map { max(0, $0 / 1_000) }
            ?? 0.35
        #else
        let minimumVisibleSeconds = 0.35
        #endif
        let remaining = minimumVisibleSeconds - Date().timeIntervalSince(startedAt)
        if remaining > 0 {
            try? await Task.sleep(for: .seconds(remaining))
        }
    }

    private func logDestination(_ destination: String) {
        let elapsedMs = launchStartedAt.map { Date().timeIntervalSince($0) * 1_000 } ?? 0
        KLog.diag(
            "[MacLaunch] destination=\(destination) "
                + String(format: "elapsedMs=%.1f", elapsedMs)
        )
    }

    func retryLogin(appState: AppState) async {
        guard !isCheckingCredentials else { return }
        isCheckingCredentials = true
        loginCheckFailed = false
        defer { isCheckingCredentials = false }

        KLog.diag("[MacLaunch] retrying CLI credential discovery")
        let usedCLILogin = await appState.attemptCLILogin()
        if usedCLILogin || appState.hasStoredCredentials {
            if !usedCLILogin, appState.connectionStatus == .awaitingLogin {
                appState.connect()
            }
            launchStartedAt = Date()
            beginPreparingAuthenticatedSurface()
        } else {
            loginCheckFailed = true
        }
    }

    func reconcileAuthentication(
        hasStoredCredentials: Bool,
        connectionStatus: ConnectionStatus
    ) {
        guard phase != .launching else { return }
        if hasStoredCredentials {
            loginCheckFailed = false
            if phase == .signedOut {
                launchStartedAt = Date()
                beginPreparingAuthenticatedSurface()
            }
        } else if connectionStatus == .awaitingLogin,
                  phase == .authenticated || phase == .preparingAuthenticated {
            // Explicit logout or a failed first authentication returns to the
            // shared entry gate and drops process-local navigation state.
            presentationWatchdogTask?.cancel()
            presentationWatchdogTask = nil
            lastSelectedSessionId = nil
            phase = .signedOut
        }
    }

    func recordSelectedSession(_ sessionId: String?) {
        lastSelectedSessionId = sessionId
    }
}

@main
struct MacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate

    @State private var appState: AppState
    @State private var tentacleCLI = TentacleCLIManager()
    @State private var launchCoordinator = MacLaunchCoordinator()
    @AppStorage("colorScheme") private var colorScheme: AppColorScheme = .system

    init() {
        // Two launch modes (selected via the `KRAKI_DEV_LOCAL` scheme
        // env var):
        //
        //   • KRAKI_DEV_LOCAL=1 — connect to the local `pnpm dev` full
        //     stack exactly like the web app: head relay on
        //     ws://localhost:4400, open auth (no login), real sessions
        //     served by the dev daemon. That daemon runs under
        //     KRAKI_HOME=.tmp/kraki-local, so the user's global
        //     ~/.kraki daemon is never touched. The actual
        //     `devConnect()` is kicked off from the WindowGroup `.task`
        //     once the run loop is alive.
        //
        //   • default — seed mock content so we can iterate on layout
        //     without any backend. Remove once the live path is the
        //     only path.
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        let isolatedChatTest = environment["KRAKI_MAC_CHAT_SNAPSHOT_TEST"] == "1"
            || environment["KRAKI_MAC_CHAT_PERF_PAGE"] == "1"
            || environment["KRAKI_MAC_CHAT_SCENARIO_PAGE"] == "1"
        let state: AppState
        if isolatedChatTest {
            // These pages must never construct the production graph first:
            // AppState() initializes the real device identity and Keychain
            // before the page can opt out of networking. Open only the
            // explicitly isolated database used by the fixture harness.
            do {
                let databaseURL = KrakiDataPaths.persistentDirectory()
                    .appendingPathComponent("messages.sqlite", isDirectory: false)
                let loadPersistedState = environment["KRAKI_MAC_CHAT_SNAPSHOT_TEST"] == "1"
                    || environment["KRAKI_MAC_CHAT_PERF_PAGE"] == "1"
                state = AppState(
                    testDatabase: try MessageDatabase(databaseURL: databaseURL),
                    loadPersistedState: loadPersistedState
                )
            } catch {
                fatalError("Failed to open isolated chat test database: \(error)")
            }

            // Seed the authoritative per-Session heads before MainWindowView
            // mounts. Production receives these from session_list before/while
            // entering Chat; without this seed an offline snapshot would issue
            // a fixture-only head request and leave loadingSessions true until
            // its timeout even though the copied SQLite DB is already at head.
            for session in state.sessionStore.sessions.values {
                state.messageProvider?.setTentacleInfo(
                    sessionId: session.id,
                    lastSeq: max(session.lastSeq, state.messageStore.dbLastSeq(session.id)),
                    deviceId: session.deviceId
                )
            }
        } else {
            state = AppState()
            if environment["KRAKI_DEV_LOCAL"] == "1" {
                state.devLocalActive = true
            } else if environment["KRAKI_MAC_MOCK"] == "1" {
                MacMockData.install(into: state)
            }
        }
        #else
        let state = AppState()
        #endif
        _appState = State(initialValue: state)
    }

    var body: some Scene {
        Window("Kraki", id: "main") {
            Group {
                #if DEBUG
                if ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_SCENARIO_PAGE"] == "1" {
                    MacChatScenarioTestView()
                } else if ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_PERF_PAGE"] == "1" {
                    MacChatPerfTestView()
                } else if let fixture = ProcessInfo.processInfo.environment["KRAKI_MAC_ENTRY_GATE_PAGE"] {
                    MacEntryGateView(
                        mode: fixture.hasPrefix("signed-out") ? .signedOut : .launching,
                        isCheckingCredentials: fixture == "signed-out-checking",
                        loginCheckFailed: fixture == "signed-out-failed"
                    )
                } else {
                    productionRoot
                }
                #else
                productionRoot
                #endif
            }
                .environment(appState)
                .environment(tentacleCLI)
                .preferredColorScheme(colorScheme.scheme)
                // .windowZoom() must wrap the content BEFORE the window
                // min-size frame. If the min-size frame is inside the
                // zoom, zooming in proposes `windowSize / zoom` (smaller)
                // to a frame that refuses to shrink below its minimum and
                // then *centers* the oversized content — shoving it up
                // above the window's top edge, under the traffic lights.
                // Keeping the min-size frame outside constrains the
                // window, while the zoom divides the true window size.
                .windowZoom()
                .frame(minWidth: 800, idealWidth: 1100, minHeight: 600, idealHeight: 720)
                .animation(.easeInOut(duration: 0.16), value: launchCoordinator.isLaunchGateVisible)
                .onReceive(NotificationCenter.default.publisher(for: .macSelectSession)) { note in
                    // Explicit user/deep-link navigation is allowed to cross the
                    // cold-launch gate. Scenario-window notifications are scoped
                    // and must never seed the production window.
                    guard note.userInfo?["scope"] as? String == nil,
                          let sessionId = note.userInfo?["sessionId"] as? String else { return }
                    launchCoordinator.recordSelectedSession(sessionId)
                }
                #if DEBUG
                .onReceive(NotificationCenter.default.publisher(for: .macNativeAutomationAction)) { note in
                    guard MacAutomationDriver.shared.enabled,
                          note.userInfo?["action"] as? String == "selectSession",
                          let sessionId = note.userInfo?["sessionId"] as? String else { return }
                    launchCoordinator.recordSelectedSession(sessionId)
                }
                #endif
                .onChange(of: appState.hasStoredCredentials) { _, hasStoredCredentials in
                    launchCoordinator.reconcileAuthentication(
                        hasStoredCredentials: hasStoredCredentials,
                        connectionStatus: appState.connectionStatus
                    )
                }
                .onChange(of: appState.connectionStatus) { _, connectionStatus in
                    launchCoordinator.reconcileAuthentication(
                        hasStoredCredentials: appState.hasStoredCredentials,
                        connectionStatus: connectionStatus
                    )
                }
                .onReceive(NotificationCenter.default.publisher(
                    for: NSApplication.didBecomeActiveNotification
                )) { _ in
                    if launchCoordinator.phase == .signedOut {
                        // Returning from Terminal after `kraki connect` should
                        // discover the new CLI login without requiring a relaunch.
                        Task {
                            await launchCoordinator.retryLogin(appState: appState)
                        }
                    } else {
                        // macOS keeps the broker connection optimistically warm;
                        // activation bypasses any stale reconnect backoff.
                        appState.handleForegroundRehydrate()
                    }
                }
                .onReceive(NotificationCenter.default.publisher(
                    for: NSWindow.didBecomeKeyNotification
                )) { _ in
                    // Re-focus should recover immediately even if the app never
                    // transitioned through an inactive scene phase.
                    appState.handleForegroundRehydrate()
                }
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(
                    for: NSWorkspace.didWakeNotification
                )) { _ in
                    appState.handleForegroundRehydrate()
                }
                .task {
                    #if DEBUG
                    MacAutomationDriver.shared.start(appState: appState)
                    #endif
                    let environment = ProcessInfo.processInfo.environment
                    let bypassProductionLaunch = environment["KRAKI_MAC_CHAT_SNAPSHOT_TEST"] == "1"
                        || environment["KRAKI_MAC_CHAT_PERF_PAGE"] == "1"
                        || environment["KRAKI_MAC_CHAT_SCENARIO_PAGE"] == "1"
                        || environment["KRAKI_MAC_ENTRY_GATE_PAGE"] != nil
                    await launchCoordinator.bootstrap(
                        appState: appState,
                        tentacleCLI: tentacleCLI,
                        devLocal: appState.devLocalActive,
                        mock: environment["KRAKI_MAC_MOCK"] == "1",
                        bypassProductionLaunch: bypassProductionLaunch
                    )
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .windowResizability(.contentMinSize)
        .defaultLaunchBehavior(.presented)
        .commands {
            MacCommands(appState: appState, tentacleCLI: tentacleCLI)
        }

        Settings {
            PreferencesWindow()
                .environment(appState)
                .environment(tentacleCLI)
                .frame(width: 540, height: 420)
        }

        Window("Logs", id: "logs") {
            LogsWindow()
                .environment(tentacleCLI)
                .frame(minWidth: 600, minHeight: 400)
        }
        .keyboardShortcut("l", modifiers: .command)
        .defaultPosition(.center)

        #if DEBUG
        Window("Chat Scenario Test Page", id: "chat-scenarios") {
            MacChatScenarioTestView(selectionScope: "chat-scenarios")
                .preferredColorScheme(colorScheme.scheme)
                .windowZoom()
                .frame(minWidth: 1120, idealWidth: 1480, minHeight: 700, idealHeight: 920)
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1480, height: 920)
        #endif

        MenuBarExtra {
            MenuBarExtraView()
                .environment(appState)
                .environment(tentacleCLI)
        } label: {
            Label("Kraki", systemImage: tentacleCLI.menuBarSymbolName)
        }
        .menuBarExtraStyle(.menu)
    }

    @ViewBuilder
    private var productionRoot: some View {
        switch launchCoordinator.phase {
        case .launching, .preparingAuthenticated, .authenticated:
            ZStack {
                if launchCoordinator.phase != .launching {
                    MainWindowView(
                        // A cold-launch deep link remains queued until the shell's
                        // first frame is ready, so Chat/Composer never mount behind
                        // the launch gate. Warm reopen still restores immediately.
                        initialSelectedSessionId: launchCoordinator.phase == .authenticated
                            ? launchCoordinator.lastSelectedSessionId
                            : nil,
                        onSelectedSessionChanged: { sessionId in
                            launchCoordinator.recordSelectedSession(sessionId)
                        }
                    )
                    .allowsHitTesting(launchCoordinator.phase == .authenticated)
                    .accessibilityHidden(launchCoordinator.phase != .authenticated)
                    .background(
                        MacLaunchPresentationReadyProbe {
                            Task {
                                await launchCoordinator.authenticatedSurfaceDidPresent()
                            }
                        }
                    )
                }

                if launchCoordinator.isLaunchGateVisible {
                    MacEntryGateView(mode: .launching)
                        .transition(.opacity)
                        .zIndex(10)
                }
            }
        case .signedOut:
            LoginView(
                isCheckingCredentials: launchCoordinator.isCheckingCredentials,
                loginCheckFailed: launchCoordinator.loginCheckFailed,
                onRetry: {
                    Task {
                        await launchCoordinator.retryLogin(appState: appState)
                    }
                }
            )
            .transition(.opacity)
        }
    }
}

/// Signals only after the authenticated AppKit surface is attached and has
/// completed a real window layout pass. Keeping the launch gate above that work
/// prevents the user from seeing a half-materialized Sidebar followed by a
/// blocked frame.
private struct MacLaunchPresentationReadyProbe: NSViewRepresentable {
    let onReady: () -> Void

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.onReady = onReady
        return view
    }

    func updateNSView(_ nsView: ProbeView, context: Context) {
        nsView.onReady = onReady
        nsView.signalWhenReady()
    }

    final class ProbeView: NSView {
        var onReady: (() -> Void)?
        private var didSignal = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            signalWhenReady()
        }

        func signalWhenReady() {
            guard window != nil, !didSignal else { return }
            didSignal = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.window?.contentView?.layoutSubtreeIfNeeded()
                DispatchQueue.main.async { [weak self] in
                    self?.onReady?()
                }
            }
        }
    }
}

#endif
