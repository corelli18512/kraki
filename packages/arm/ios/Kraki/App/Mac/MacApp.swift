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
import SwiftUI

@main
struct MacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate

    @State private var appState: AppState
    @State private var tentacleCLI = TentacleCLIManager()
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
        let state = AppState()
        #if DEBUG
        let snapshotTest = ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_SNAPSHOT_TEST"] == "1"
        if snapshotTest {
            state.hasStoredCredentials = true
            state.hasCompletedInitialConnect = true
            state.connectionStatus = .disconnected
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
        } else if ProcessInfo.processInfo.environment["KRAKI_DEV_LOCAL"] == "1" {
            state.devLocalActive = true
        } else if ProcessInfo.processInfo.environment["KRAKI_MAC_MOCK"] == "1" {
            MacMockData.install(into: state)
        }
        #endif
        _appState = State(initialValue: state)
    }

    var body: some Scene {
        WindowGroup("Kraki", id: "main") {
            Group {
                #if DEBUG
                if ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_PERF_PAGE"] == "1" {
                    MacChatPerfTestView()
                } else {
                    MainWindowView()
                }
                #else
                MainWindowView()
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
                .task {
                    #if DEBUG
                    MacAutomationDriver.shared.start(appState: appState)
                    #endif
                    let snapshotTest = ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_SNAPSHOT_TEST"] == "1"
                        || ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_PERF_PAGE"] == "1"
                    if snapshotTest {
                        // The snapshot harness runs the production UI and local
                        // data stack unchanged against an isolated KRAKI_DATA_DIR.
                        // Never authenticate, connect, poll daemons, or mutate a
                        // real Tentacle from this process.
                        return
                    }
                    let isMock = ProcessInfo.processInfo.environment["KRAKI_MAC_MOCK"] == "1"
                    if appState.devLocalActive {
                        appState.devConnect()
                    } else if !isMock {
                        // Prefer the existing CLI login on macOS. It is an
                        // independent credential and can recover from a
                        // denied/stale Keychain ACL without clearing the
                        // user's stored device identity.
                        let usedCLILogin = await appState.attemptCLILogin()
                        if !usedCLILogin, appState.hasStoredCredentials {
                            // No CLI credential available: returning-user
                            // fallback is challenge auth against the stored
                            // device and its Keychain signing key.
                            appState.connect()
                        }
                    }
                    await tentacleCLI.refreshInstallState()
                    await tentacleCLI.refreshDaemonState()
                    tentacleCLI.startPolling()
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

        MenuBarExtra {
            MenuBarExtraView()
                .environment(appState)
                .environment(tentacleCLI)
        } label: {
            Label("Kraki", systemImage: tentacleCLI.menuBarSymbolName)
        }
        .menuBarExtraStyle(.menu)
    }
}

#endif
