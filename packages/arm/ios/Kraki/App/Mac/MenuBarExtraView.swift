/// MenuBarExtraView — Status item dropdown content.
///
/// Items per plan:
///   • Status row (daemon state + CLI version)
///   • Open Kraki                      ⌘N — no, ⌘0 — actually just brings window forward
///   • Quick Send to "<last active>"   (deferred — needs message router work)
///   • Tentacle ▸ Start / Stop / Restart / Show Logs / Reset Setup
///   • Quit Kraki

#if os(macOS)
import SwiftUI
import AppKit

struct MenuBarExtraView: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        statusRow

        Divider()

        Button("Open Kraki") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
            DispatchQueue.main.async {
                for w in NSApp.windows where w.canBecomeKey {
                    w.makeKeyAndOrderFront(nil)
                    break
                }
            }
        }
        .keyboardShortcut("0", modifiers: .command)

        Menu("This Mac") {
            Button("Start Background Service") {
                Task { await tentacleCLI.startDaemon() }
            }
            .disabled(!tentacleCLI.canStartDaemon)
            Button("Stop Background Service") {
                Task { await tentacleCLI.stopDaemon() }
            }
            .disabled(!tentacleCLI.canStopDaemon)
            Button("Restart Background Service") {
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
        }

        Divider()

        Button("Preferences…") { openSettings() }
            .keyboardShortcut(",", modifiers: .command)

        Button("Quit Kraki") {
            NSApp.terminate(nil)
        }
        .keyboardShortcut("q", modifiers: .command)
    }

    @ViewBuilder
    private var statusRow: some View {
        let line: String = {
            switch tentacleCLI.daemonState {
            case .running(let pid):
                return "Running on this Mac (pid \(pid))"
            case .starting: return "Starting on this Mac…"
            case .stopping: return "Stopping on this Mac…"
            case .stopped:  return "Not running on this Mac"
            case .needsApproval: return "Turned off in Login Items"
            case .error(let msg): return "Error: \(msg)"
            case .unknown:  return "Checking this Mac…"
            }
        }()
        Text(line)
            .disabled(true)
    }
}

#endif
