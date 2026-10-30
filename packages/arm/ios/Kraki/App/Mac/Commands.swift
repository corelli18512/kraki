/// MacCommands — the top menu bar of Kraki for Mac.
///
/// Shortcut rules: never take a key a text field uses while typing a
/// message (⌘↑/⌘↓ jump to the start/end, ⌘⌫ deletes to the line start),
/// and keep the standard window keys (⌘W, ⌘M, ⌘H) working.

#if os(macOS)
import SwiftUI

struct MacCommands: Commands {
    let appState: AppState
    let tentacleCLI: TentacleCLIManager

    @AppStorage("mac.inspectorShown") private var inspectorShown: Bool = false
    @Environment(\.openWindow) private var openWindow

    /// True when a session is currently selected in the main window.
    private var hasActiveSession: Bool {
        appState.sessionStore.activeSessionId != nil
    }

    /// Pinned state of the currently selected session (for the menu label).
    private var activeSessionPinned: Bool {
        guard let id = appState.sessionStore.activeSessionId else { return false }
        return appState.sessionStore.sessions[id]?.pinned ?? false
    }

    private var activeSessionUnread: Bool {
        guard let id = appState.sessionStore.activeSessionId else { return false }
        return appState.sessionStore.isUnread(id)
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

        // (Grouped: a Commands body takes at most ten direct children.)
        windowCommands
        mainCommands
    }

    @CommandsBuilder
    private var windowCommands: some Commands {
        // Hide Kraki (⌘H) stays; Hide Others / Show All are not wanted.
        CommandGroup(replacing: .appVisibility) {
            Button("Hide Kraki") { NSApp.hide(nil) }
                .keyboardShortcut("h", modifiers: .command)
        }

        // Window menu: only what a single-window app needs. The File menu is
        // removed (MacAppDelegate), so Close Window lives here; without it
        // ⌘W would close nothing, not even Settings.
        CommandGroup(before: .windowSize) {
            Button("Close Window") { NSApp.keyWindow?.performClose(nil) }
                .keyboardShortcut("w", modifiers: .command)
        }
        CommandGroup(replacing: .windowList) { }
        CommandGroup(replacing: .windowArrangement) { }
    }

    @CommandsBuilder
    private var mainCommands: some Commands {

        // View menu — replace the default toolbar items (Show/Customize
        // Toolbar — we have no toolbar) with our own toggles + zoom.
        CommandGroup(replacing: .toolbar) {
            Button("Toggle Sidebar") {
                NotificationCenter.default.post(name: .macToggleSidebar, object: nil)
            }
            .keyboardShortcut("s", modifiers: [.command, .control])

            Button(inspectorShown ? String(localized: "Hide Inspector") : String(localized: "Show Inspector")) {
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
            // ⌥⌘: plain ⌘↑ jumps to the start of the message being typed.
            .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            .disabled(appState.sessionStore.sessions.isEmpty)

            Button("Next Session") {
                NotificationCenter.default.post(
                    name: .macNavigateSession,
                    object: nil,
                    userInfo: ["direction": 1]
                )
            }
            .keyboardShortcut(.downArrow, modifiers: [.command, .option])
            .disabled(appState.sessionStore.sessions.isEmpty)

            Divider()

            // ⌘1–⌘9 open the first nine sessions in sidebar order, by title.
            // The list is sorted once per menu update (not once per item).
            let firstNine = Array(appState.sessionStore.navigationOrderedSessions.prefix(9))
            ForEach(Array(firstNine.enumerated()), id: \.element.id) { index, session in
                Button(Self.menuTitle(session.displayTitle)) {
                    NotificationCenter.default.post(
                        name: .macNavigateSession,
                        object: nil,
                        userInfo: ["index": index]
                    )
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
            }

            Divider()

            Button("Rename…") {
                guard let id = appState.sessionStore.activeSessionId else { return }
                // Rename lives in Session Info, which the open chat presents.
                MacSessionInfoRequest.pending = id
                NotificationCenter.default.post(name: .macOpenSessionInfo, object: nil,
                                                userInfo: ["sessionId": id])
            }
            .disabled(!hasActiveSession)

            Button(activeSessionPinned ? String(localized: "Unpin Session") : String(localized: "Pin Session")) {
                guard let id = appState.sessionStore.activeSessionId,
                      let s = appState.sessionStore.sessions[id] else { return }
                appState.commandSender?.pinSession(sessionId: id, pinned: !s.pinned)
            }
            .disabled(!hasActiveSession)

            Button(activeSessionUnread ? String(localized: "Mark Read") : String(localized: "Mark Unread")) {
                guard let id = appState.sessionStore.activeSessionId,
                      let session = appState.sessionStore.sessions[id] else { return }
                if appState.sessionStore.isUnread(id) {
                    appState.commandSender?.markRead(sessionId: id, seq: session.lastSeq)
                } else {
                    appState.commandSender?.markUnread(sessionId: id)
                }
            }
            .disabled(!hasActiveSession)

            Button("Fork Session") {
                guard let id = appState.sessionStore.activeSessionId else { return }
                appState.commandSender?.forkSession(sessionId: id)
            }
            .disabled(!hasActiveSession)

            Button("Archive") {
                guard let id = appState.sessionStore.activeSessionId else { return }
                NotificationCenter.default.post(name: .macArchiveSession, object: nil,
                                                userInfo: ["sessionId": id])
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
            // No shortcut: ⌘⌫ deletes to the line start while typing.
            .disabled(!hasActiveSession)
        }

        #if DEBUG
        CommandMenu("Debug") {
            Button("Chat Scenario Test Page") {
                openWindow(id: "chat-scenarios")
            }
            .keyboardShortcut("t", modifiers: [.command, .option])
        }
        #endif

        // "This Mac" menu: whether this Mac is online (MacPresence.swift).
        // The status is polled, so there is no Refresh item. A Mac that only
        // controls other computers gets just its status and the agents window.
        CommandMenu("This Mac") {
            Text(tentacleCLI.onlineStatus.title)

            if tentacleCLI.onlineStatus != .controlsOthersOnly {
                // Only the action that applies now (as in the menu bar menu).
                if tentacleCLI.canGoOffline {
                    Button("Take This Mac Offline") {
                        Task { await tentacleCLI.goOffline() }
                    }
                } else {
                    Button("Bring This Mac Online") {
                        Task { await tentacleCLI.goOnline() }
                    }
                    .disabled(!tentacleCLI.canGoOnline)
                }

                Button("Reconnect This Mac…") {
                    guard MacReconnectConfirmation.confirm(appState: appState, tentacleCLI: tentacleCLI) else { return }
                    Task { await tentacleCLI.restartDaemon() }
                }
                .disabled(!tentacleCLI.canStopDaemon)
            }

            Divider()

            Button("Coding Agents on This Mac…") {
                openWindow(id: "local-agents")
            }

            if tentacleCLI.onlineStatus != .controlsOthersOnly {
                Divider()

                Button("Show Logs in Finder") {
                    tentacleCLI.openLogsInFinder()
                }
            }
        }

        // App menu — Sparkle owns the standard update dialog and installation
        // lifecycle; this command only routes the user's explicit request.
        // ⌘Q puts the window away while this Mac is online: quitting would
        // take it offline, which is what the menu bar's Quit is for.
        CommandGroup(replacing: .appTermination) {
            if tentacleCLI.managesOnlinePresence && tentacleCLI.canGoOffline {
                Button("Close Kraki (Stay Online)") {
                    MacPresenceController.shared.closeWindowsStayingOnline()
                }
                .keyboardShortcut("q", modifiers: .command)
                Button("Quit Kraki and Go Offline…") {
                    MacPresenceController.shared.quitGoingOffline()
                }
            } else {
                Button("Quit Kraki") {
                    MacPresenceController.shared.quitGoingOffline()
                }
                .keyboardShortcut("q", modifiers: .command)
            }
        }

        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") {
                NotificationCenter.default.post(name: .macCheckForUpdates, object: nil)
            }
            Divider()
            Button("Connect Your Phone…") {
                NotificationCenter.default.post(name: .macOpenPairing, object: nil)
            }
        }

        // Help menu — replace the default (search field + nothing useful).
        // No "Rate Kraki": the Mac app isn't on the App Store, where a review
        // request would go.
        CommandGroup(replacing: .help) {
            Button("Send Feedback…") {
                if let url = URL(string: "https://github.com/corelli18512/kraki/issues/new") {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    /// Session titles can be long; menus don't wrap.
    static func menuTitle(_ title: String) -> String {
        title.count > 48 ? String(title.prefix(47)) + "…" : title
    }
}

/// Reconnecting restarts the service on this Mac, which stops every running
/// turn here: ask first when one is running.
@MainActor
enum MacReconnectConfirmation {
    static func runningSessionsHere(appState: AppState, tentacleCLI: TentacleCLIManager) -> Int {
        guard let here = tentacleCLI.configInfo?.deviceId else { return 0 }
        return appState.sessionStore.sessions.values.filter { $0.deviceId == here && $0.state != .idle }.count
    }

    static func confirm(appState: AppState, tentacleCLI: TentacleCLIManager) -> Bool {
        let running = runningSessionsHere(appState: appState, tentacleCLI: tentacleCLI)
        guard running > 0 else { return true }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = String(localized: "Reconnect this Mac?")
        alert.informativeText = running == 1
            ? String(localized: "A session is running on this Mac. Reconnecting restarts Kraki here and stops it.")
            : String(localized: "\(running) sessions are running on this Mac. Reconnecting restarts Kraki here and stops them.")
        alert.addButton(withTitle: String(localized: "Reconnect"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        return alert.runModal() == .alertFirstButtonReturn
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
    static let macFocusNewSessionComposer = Notification.Name("mac.focusNewSessionComposer")
    static let macOpenSessionInfo = Notification.Name("mac.openSessionInfo")
    static let macToggleSidebar   = Notification.Name("mac.toggleSidebar")
    static let macNavigateSession  = Notification.Name("mac.navigateSession")
    static let macDeleteSession   = Notification.Name("mac.deleteSession")
    static let macArchiveSession  = Notification.Name("mac.archiveSession")
    static let macCheckForUpdates  = Notification.Name("mac.checkForUpdates")
    /// Object: the `MacUpdateChannel` to switch to (Settings › General).
    static let macSwitchUpdateChannel = Notification.Name("mac.switchUpdateChannel")
}

/// Session Info asked for a Session whose chat may not be open yet (a row's
/// Rename…): the chat shows it as soon as it appears.
@MainActor
enum MacSessionInfoRequest {
    static var pending: String?

    static func take(_ sessionId: String) -> Bool {
        guard pending == sessionId else { return false }
        pending = nil
        return true
    }
}

#endif
