/// TentaclePane — CLI install state + daemon control + log path.
///
/// Mirrors the welcome card design but lives inside Preferences so
/// users can come back to it any time without leaving a chat.

#if os(macOS)
import SwiftUI

struct TentaclePane: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI

    @AppStorage("tentacle.autostart") private var autostart: Bool = false

    var body: some View {
        Form {
            Section("Install") {
                installContent
                Button("Re-check") {
                    Task { await tentacleCLI.refreshInstallState() }
                }
            }

            Section("Daemon") {
                daemonContent
                Toggle("Start tentacle automatically when Kraki opens", isOn: $autostart)
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
        .padding()
    }

    // MARK: - Install section

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
                Text("npm install -g @kraki/cli")
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
            ProgressView("Talking to daemon…").controlSize(.small)
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
        case .running(let pid):
            HStack {
                Label("Running (pid \(pid))", systemImage: "circle.fill")
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
