/// TentaclePane — which tentacle this Mac runs (built-in or external CLI),
/// daemon control, permissions and logs.
///
/// Mirrors the welcome card design but lives inside Preferences so
/// users can come back to it any time without leaving a chat.

#if os(macOS)
import SwiftUI

struct TentaclePane: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.openWindow) private var openWindow
    @AppStorage(BuiltInTentacle.thisMacRoleKey) private var runsAgentsHere = ""

    @AppStorage("tentacle.autostart") private var autostart: Bool = false
    @State private var switching = false

    var body: some View {
        Form {
            if tentacleCLI.isBuiltInAvailable {
                Section("Agents on This Mac") {
                    modeContent
                }
            }

            if tentacleCLI.mode == .external {
                Section("Install") {
                    installContent
                    Button("Re-check") {
                        Task { await tentacleCLI.refreshInstallState() }
                    }
                }
            }

            Section("Background Service") {
                daemonContent
                if tentacleCLI.mode == .external {
                    Toggle("Start the background service when Kraki opens", isOn: $autostart)
                } else {
                    Text("Runs in the background and starts when you log in. You can also turn it off in System Settings → General → Login Items.")
                        .font(.caption)
                        .foregroundStyle(Color.textSecondary)
                }
            }

            if tentacleCLI.mode == .builtIn {
                Section("Permissions") {
                    fdaContent
                }
                Section {
                    ForEach(BuiltInTentacle.agentPrivacyPanes, id: \.anchor) { pane in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(pane.title)
                                Text(pane.detail)
                                    .font(.caption)
                                    .foregroundStyle(Color.textSecondary)
                            }
                            Spacer()
                            Button("Open") { BuiltInTentacle.openPrivacyPane(pane.anchor) }
                        }
                    }
                    Button("Show Kraki's Background Service in Finder") {
                        BuiltInTentacle.revealHelperInFinder()
                    }
                } header: {
                    Text("For Agents That Operate the Computer")
                } footer: {
                    Text("Optional. Agents run under Kraki's background service, so turn these on for \"Kraki\" if you want agents to click, type, see the screen or control apps. If Kraki isn't in a list yet, drag it in from the Finder window.")
                        .font(.caption)
                        .foregroundStyle(Color.textSecondary)
                }
            }

            Section("Logs") {
                LabeledContent("Path", value: tentacleCLI.logsDirectory)
                    .textSelection(.enabled)
                HStack {
                    Button("Show in Finder") {
                        tentacleCLI.openLogsInFinder()
                    }
                    Button("Open Logs Window") {
                        NotificationCenter.default.post(name: .macOpenLogs, object: nil)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    // MARK: - Mode section

    @ViewBuilder
    private var modeContent: some View {
        Picker("Run agents with", selection: Binding(
            get: { tentacleCLI.mode },
            set: { target in
                switching = true
                Task {
                    await tentacleCLI.switchMode(to: target)
                    switching = false
                }
            }
        )) {
            Text("Kraki (built in)").tag(TentacleMode.builtIn)
            Text("External kraki CLI").tag(TentacleMode.external)
        }
        .pickerStyle(.radioGroup)
        .disabled(switching || (tentacleCLI.externalCLI == nil && tentacleCLI.mode == .builtIn))

        if tentacleCLI.mode == .builtIn {
            Toggle("Run agents on this Mac", isOn: Binding(
                get: { runsAgentsHere != BuiltInTentacle.ThisMacRole.remoteOnly.rawValue },
                set: { on in
                    runsAgentsHere = (on ? BuiltInTentacle.ThisMacRole.runsAgents : .remoteOnly).rawValue
                    Task { await tentacleCLI.setRunsAgentsOnThisMac(on) }
                }
            ))
            Text("When off, this Mac only controls agents on your other computers.")
                .font(.caption)
                .foregroundStyle(Color.textSecondary)
            LabeledContent("Coding agents") {
                Button("Check Coding Agents…") { openWindow(id: "local-agents") }
            }
            LabeledContent("Version", value: tentacleCLI.builtIn.version ?? "unknown")
            if tentacleCLI.externalCLI != nil {
                Text("The kraki CLI on this Mac stays usable for commands like `kraki status` and `kraki logs`; Kraki keeps running the background service.")
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
            }
        } else {
            Text("Switching to Kraki stops the CLI's background service and keeps your sign-in and sessions. You'll grant Full Disk Access to Kraki once.")
                .font(.caption)
                .foregroundStyle(Color.textSecondary)
        }
    }

    // MARK: - Install section (external CLI)

    @ViewBuilder
    private var installContent: some View {
        switch tentacleCLI.installState {
        case .unknown:
            ProgressView("Detecting kraki…")
                .controlSize(.small)
        case .notFound:
            VStack(alignment: .leading, spacing: 6) {
                Label("kraki not found in PATH", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color(hex: 0xFBBF24))
                Text("Install via Terminal:")
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                Text(WelcomeView.cliInstallCommand)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.surfaceTertiary)
                    )
                Button("Locate kraki manually…") {
                    Task { await locateManually() }
                }
            }
        case .available(let path, let version):
            VStack(alignment: .leading, spacing: 4) {
                Label("kraki found", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Color(hex: 0x34D399))
                LabeledContent("Path", value: path)
                    .textSelection(.enabled)
                LabeledContent("Version", value: version ?? "unknown")
            }
        }
    }

    // MARK: - Daemon section

    @ViewBuilder
    private var daemonContent: some View {
        switch tentacleCLI.daemonState {
        case .unknown:
            ProgressView("Checking…").controlSize(.small)
        case .stopped:
            HStack {
                Label("Stopped", systemImage: "moon.zzz.fill")
                    .foregroundStyle(Color.textMuted)
                Spacer()
                Button("Start") { Task { await tentacleCLI.startDaemon() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.krakiPrimary)
                    .disabled(!tentacleCLI.canStartDaemon)
            }
        case .starting:
            ProgressView("Starting…").controlSize(.small)
        case .stopping:
            ProgressView("Stopping…").controlSize(.small)
        case .needsApproval:
            VStack(alignment: .leading, spacing: 6) {
                Label("Turned off in Login Items", systemImage: "exclamationmark.circle.fill")
                    .foregroundStyle(Color(hex: 0xFBBF24))
                HStack {
                    Button("Open Login Items") { BuiltInTentacle.openLoginItemsSettings() }
                    Button("Try Again") { Task { await tentacleCLI.startDaemon() } }
                }
            }
        case .running(let pid):
            HStack {
                Label("Running (pid \(String(pid)))", systemImage: "circle.fill")
                    .foregroundStyle(Color(hex: 0x34D399))
                Spacer()
                Button("Stop") { Task { await tentacleCLI.stopDaemon() } }
                Button("Restart") { Task { await tentacleCLI.restartDaemon() } }
            }
        case .error(let msg):
            VStack(alignment: .leading, spacing: 4) {
                Label("Error", systemImage: "xmark.octagon.fill")
                    .foregroundStyle(Color(hex: 0xF4836E))
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                Button("Retry") { Task { await tentacleCLI.startDaemon() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.krakiPrimary)
            }
        }
    }

    // MARK: - Permissions section (built-in)

    @ViewBuilder
    private var fdaContent: some View {
        HStack {
            switch tentacleCLI.fdaStatus {
            case "granted":
                Label("Full Disk Access granted", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Color(hex: 0x34D399))
            case "denied":
                Label("Full Disk Access not granted", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color(hex: 0xFBBF24))
            default:
                Label("Full Disk Access: checked while the background service runs", systemImage: "questionmark.circle")
                    .foregroundStyle(Color.textMuted)
            }
            Spacer()
            Button("Open System Settings") { BuiltInTentacle.openFullDiskAccessSettings() }
        }
    }

    // MARK: - Actions

    private func locateManually() async {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.title = "Locate kraki executable"
        panel.directoryURL = URL(fileURLWithPath: "/usr/local/bin")
        if panel.runModal() == .OK, let url = panel.url {
            tentacleCLI.setBinaryPathOverride(url.path)
            await tentacleCLI.refreshInstallState()
        }
    }
}

#endif
