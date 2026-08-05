/// MacCommands — Top menu bar layout for the mac target.
///
/// All shortcuts come from the plan's keyboard map. Heavier actions
/// (new session, pairing, search) are stubbed with TODO markers; they
/// route to AppState and TentacleCLIManager primitives once the
/// corresponding sheets/views land.

#if os(macOS)
import SwiftUI

struct MacCommands: Commands {
    let appState: AppState
    let tentacleCLI: TentacleCLIManager

    @AppStorage("mac.inspectorShown") private var inspectorShown: Bool = false

    /// True when a session is currently selected in the main window.
    private var hasActiveSession: Bool {
        appState.sessionStore.activeSessionId != nil
    }

    /// Pinned state of the currently selected session (for the menu label).
    private var activeSessionPinned: Bool {
        guard let id = appState.sessionStore.activeSessionId else { return false }
        return appState.sessionStore.sessions[id]?.pinned ?? false
    }

    var body: some Commands {
        // File menu — emptied here; the whole menu is removed in
        // MacAppDelegate (New Session now lives under the Session menu).
        CommandGroup(replacing: .newItem) { }

        // Edit menu — keep defaults (Cut/Copy/Paste/Select All are
        // genuinely used for composing + copying agent output).

        // Remove the system "Services" submenu — its contents are
        // machine-wide (e.g. Xcode/Instruments "Development" services on
        // dev boxes) and irrelevant to Kraki.
        CommandGroup(replacing: .systemServices) { }

        // Remove Hide / Hide Others / Show All — not wanted for this app.
        CommandGroup(replacing: .appVisibility) { }

        // View menu — replace the default toolbar items (Show/Customize
        // Toolbar — we have no toolbar) with our own toggles + zoom.
        CommandGroup(replacing: .toolbar) {
            Button("Toggle Sidebar") {
                NotificationCenter.default.post(name: .macToggleSidebar, object: nil)
            }
            .keyboardShortcut("s", modifiers: [.command, .control])

            Button(inspectorShown ? "Hide Inspector" : "Show Inspector") {
                inspectorShown.toggle()
            }
            .keyboardShortcut("i", modifiers: [.command, .option])

            Divider()

            // App-wide UI zoom (browser-style ⌘+ / ⌘- / ⌘0).
            // Drives WindowZoomModifier via NotificationCenter so we
            // don't have to thread @AppStorage through every scene.
            Button {
                NotificationCenter.default.post(name: .macZoomIn, object: nil)
            } label: {
                Label("Zoom In", systemImage: "plus.magnifyingglass")
            }
            .keyboardShortcut("=", modifiers: .command)   // ⌘+
            Button {
                NotificationCenter.default.post(name: .macZoomOut, object: nil)
            } label: {
                Label("Zoom Out", systemImage: "minus.magnifyingglass")
            }
            .keyboardShortcut("-", modifiers: .command)   // ⌘-
            Button {
                NotificationCenter.default.post(name: .macZoomReset, object: nil)
            } label: {
                Label("Actual Size", systemImage: "1.magnifyingglass")
            }
            .keyboardShortcut("0", modifiers: .command)   // ⌘0
        }

        // Session menu — operations on the currently selected session.
        CommandMenu("Session") {
            Button("New Session") {
                NotificationCenter.default.post(name: .macOpenNewSession, object: nil)
            }
            .keyboardShortcut("n", modifiers: .command)

            Divider()

            Button("Previous Session") {
                NotificationCenter.default.post(
                    name: .macNavigateSession,
                    object: nil,
                    userInfo: ["direction": -1]
                )
            }
            .keyboardShortcut(.upArrow, modifiers: .command)
            .disabled(appState.sessionStore.sessions.isEmpty)

            Button("Next Session") {
                NotificationCenter.default.post(
                    name: .macNavigateSession,
                    object: nil,
                    userInfo: ["direction": 1]
                )
            }
            .keyboardShortcut(.downArrow, modifiers: .command)
            .disabled(appState.sessionStore.sessions.isEmpty)

            Divider()

            ForEach(1...9, id: \.self) { number in
                Button("Session \(number)") {
                    NotificationCenter.default.post(
                        name: .macNavigateSession,
                        object: nil,
                        userInfo: ["index": number - 1]
                    )
                }
                .keyboardShortcut(KeyEquivalent(Character(String(number))), modifiers: .command)
                // The shortcut only needs a count. Sorting every Session here
                // made each streaming delta sort the full Session collection
                // once per menu item through SwiftUI's command graph.
                .disabled(appState.sessionStore.sessions.count < number)
            }

            Divider()

            Button(activeSessionPinned ? "Unpin Session" : "Pin Session") {
                guard let id = appState.sessionStore.activeSessionId,
                      let s = appState.sessionStore.sessions[id] else { return }
                appState.commandSender?.pinSession(sessionId: id, pinned: !s.pinned)
            }
            .disabled(!hasActiveSession)

            Button("Mark Unread") {
                guard let id = appState.sessionStore.activeSessionId else { return }
                appState.commandSender?.markUnread(sessionId: id)
            }
            .disabled(!hasActiveSession)

            Button("Fork Session") {
                guard let id = appState.sessionStore.activeSessionId else { return }
                appState.commandSender?.forkSession(sessionId: id)
            }
            .disabled(!hasActiveSession)

            Divider()

            Button("Delete Session…") {
                guard let id = appState.sessionStore.activeSessionId else { return }
                NotificationCenter.default.post(
                    name: .macDeleteSession, object: nil,
                    userInfo: ["sessionId": id]
                )
            }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(!hasActiveSession)
        }

        // Tentacle menu.
        CommandMenu("Tentacle") {
            Button("Start Daemon") {
                Task { await tentacleCLI.startDaemon() }
            }
            .disabled(!tentacleCLI.canStartDaemon)

            Button("Stop Daemon") {
                Task { await tentacleCLI.stopDaemon() }
            }
            .disabled(!tentacleCLI.canStopDaemon)

            Button("Restart Daemon") {
                Task { await tentacleCLI.restartDaemon() }
            }
            .disabled(!tentacleCLI.canStopDaemon)

            Divider()

            Button("Show Logs in Finder") {
                tentacleCLI.openLogsInFinder()
            }
            Button("Refresh Status") {
                Task { await tentacleCLI.refreshDaemonState() }
            }

            Divider()

            Button("Pair a Device…") {
                NotificationCenter.default.post(name: .macOpenPairing, object: nil)
            }
        }

        // App menu — Sparkle owns the standard update dialog and installation
        // lifecycle; this command only routes the user's explicit request.
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") {
                NotificationCenter.default.post(name: .macCheckForUpdates, object: nil)
            }
        }

        // Help menu — replace the default (search field + nothing useful)
        // with Feedback + Rate, mirroring the iOS Settings screen.
        CommandGroup(replacing: .help) {
            Button("Send Feedback…") {
                if let url = URL(string: "https://github.com/corelli18512/kraki/issues/new") {
                    NSWorkspace.shared.open(url)
                }
            }
            Button("Rate Kraki") {
                NotificationCenter.default.post(name: .macRequestReview, object: nil)
            }
        }
    }
}

// Convenience accessors for menu enablement.
extension TentacleCLIManager {
    /// True when daemon could be started (CLI present, not already running).
    var canStartDaemon: Bool {
        guard case .available = installState else { return false }
        switch daemonState {
        case .stopped, .error, .unknown: return true
        default: return false
        }
    }

    /// True when daemon is running and can be stopped.
    var canStopDaemon: Bool {
        if case .running = daemonState { return true }
        return false
    }
}

// MARK: - Notifications

extension Notification.Name {
    static let macOpenLogs        = Notification.Name("mac.openLogs")
    static let macOpenPairing     = Notification.Name("mac.openPairing")
    static let macOpenNewSession  = Notification.Name("mac.openNewSession")
    static let macOpenSessionInfo = Notification.Name("mac.openSessionInfo")
    static let macToggleSidebar   = Notification.Name("mac.toggleSidebar")
    static let macNavigateSession  = Notification.Name("mac.navigateSession")
    static let macDeleteSession   = Notification.Name("mac.deleteSession")
    static let macRequestReview   = Notification.Name("mac.requestReview")
    static let macCheckForUpdates  = Notification.Name("mac.checkForUpdates")
}

#endif
