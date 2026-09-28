/// LocalAgentsWindow — "Coding Agents on This Mac", reachable any time after
/// setup (Tentacle menu, Settings → Tentacle, the home screen's "install a
/// coding agent" card). Same check and rows as setup step 1.
///
/// After a check, if the working agents differ from what this Mac's running
/// Kraki currently offers (for example the user just installed or signed in to
/// one), Kraki restarts its background service so the change shows up in New
/// Session right away — the daemon only detects agents when it starts.

#if os(macOS)
import SwiftUI

struct LocalAgentsWindow: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.dismiss) private var dismiss
    @State private var check = LocalAgentsCheck()
    @State private var applied: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Coding Agents on This Mac")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text("Kraki uses the agents installed and signed in on this Mac. Install or sign in to an agent in its own app or in Terminal, then click Check Again.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let binaryPath = tentacleCLI.agentCheckBinaryPath {
                LocalAgentsPanel(check: check, binaryPath: binaryPath)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.surfaceSecondary.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .task { check.run(binaryPath: binaryPath) }
            } else {
                Text("Kraki's built-in tentacle isn't available in this build.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Color.orange)
            }

            if BuiltInTentacle.thisMacRole == .remoteOnly, tentacleCLI.mode == .builtIn {
                Text("This Mac is set to only control other computers. Turn on “Run agents on this Mac” in Settings → Tentacle to use these agents.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let applied {
                Text(applied)
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textSecondary)
            }

            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 500)
        .onChange(of: check.isRunning) { wasRunning, running in
            guard wasRunning, !running else { return }
            Task { await applyIfChanged() }
        }
        .onDisappear { check.cancel() }
    }

    /// Restart the running daemon when its agents are out of date.
    private func applyIfChanged() async {
        guard case .running = tentacleCLI.daemonState,
              let deviceId = tentacleCLI.configInfo?.deviceId else { return }
        let ready = Set(check.agents.filter { $0.status == .ready }.map(\.id))
        let offered = Set(appState.deviceStore.agents(for: deviceId).map { "\($0.id)" })
        guard Self.needsRestart(ready: ready, offered: offered) else { return }
        applied = "Updating Kraki to use these agents…"
        await tentacleCLI.restartDaemon()
        applied = "Kraki now uses the agents that are ready."
    }

    /// Pure for testing: restart only when the ready set really changed.
    static func needsRestart(ready: Set<String>, offered: Set<String>) -> Bool {
        ready != offered
    }
}

#endif
