/// BuiltInSetupView — first-run setup with the tentacle built into the app.
///
/// Replaces "install the CLI and run `kraki connect`" for new users:
///
///   1. Location   — refuse to run from a translocated/disk-image path
///   2. Sign in    — GitHub device code, driven by `kraki setup --json`
///   3. Background — register the daemon with SMAppService (Login Items)
///   4. Access     — Full Disk Access for Kraki, granted once (skippable)
///
/// Every step is derived from live state (install location, config, daemon
/// status, daemon-reported FDA), so relaunching the app — which System
/// Settings forces after an FDA grant — resumes at the right place.

#if os(macOS)
import AppKit
import SwiftUI

struct BuiltInSetupView: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @State private var runner = TentacleSetupRunner()
    @AppStorage("tentacle.fdaSkipped") private var fdaSkipped = false
    @State private var finished = false

    /// Called once the tentacle is configured and running; the caller retries
    /// the credential discovery that moves the app into the signed-in UI.
    let onFinished: () -> Void

    enum Step: Equatable {
        case detecting
        case moveToApplications(AppInstallLocation)
        case signIn
        case background
        case fullDiskAccess
        case done
    }

    static func step(
        installState: TentacleCLIManager.InstallState,
        location: AppInstallLocation,
        configured: Bool,
        daemonState: TentacleCLIManager.DaemonState,
        fdaStatus: String?,
        fdaSkipped: Bool
    ) -> Step {
        if case .unknown = installState { return .detecting }
        if location != .stable { return .moveToApplications(location) }
        if !configured { return .signIn }
        guard case .running = daemonState else { return .background }
        // The worker publishes its own FDA probe a few seconds after start;
        // deciding before that would skip the step on every first run.
        guard let fdaStatus else { return .background }
        if fdaStatus == "denied", !fdaSkipped { return .fullDiskAccess }
        return .done
    }

    private var currentStep: Step {
        if case .done = runner.phase, tentacleCLI.configInfo?.exists != true {
            // Config was just written; the next status poll will confirm it.
            return .background
        }
        return Self.step(
            installState: tentacleCLI.installState,
            location: tentacleCLI.installLocation,
            configured: tentacleCLI.configInfo?.exists == true,
            daemonState: tentacleCLI.daemonState,
            fdaStatus: tentacleCLI.fdaStatus,
            fdaSkipped: fdaSkipped
        )
    }

    var body: some View {
        VStack(spacing: 14) {
            switch currentStep {
            case .detecting:
                ProgressView().controlSize(.small)
            case .moveToApplications(let location):
                moveToApplications(location)
            case .signIn:
                signIn
            case .background:
                background
            case .fullDiskAccess:
                fullDiskAccess
            case .done:
                ProgressView("Connecting…").controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
        .onChange(of: currentStep) { _, step in
            if step == .done, !finished {
                finished = true
                onFinished()
            }
        }
        .onChange(of: runner.phase) { _, phase in
            guard case .done = phase else { return }
            Task {
                await tentacleCLI.refreshDaemonState()
                await tentacleCLI.startDaemon()
            }
        }
        .task {
            // Returning users land here only when the daemon is not running.
            if currentStep == .background { await tentacleCLI.startDaemon() }
            if currentStep == .done, !finished { finished = true; onFinished() }
        }
        .onDisappear { runner.cancel() }
    }

    // MARK: Steps

    private func moveToApplications(_ location: AppInstallLocation) -> some View {
        StepCard(
            title: "Move Kraki to Applications",
            detail: location == .diskImage
                ? "Kraki is running from the disk image. Drag Kraki onto the Applications folder, then open it from there."
                : "Kraki is running from a temporary location macOS uses for downloaded apps, so it can't keep working in the background. In Finder, drag Kraki from Downloads into Applications, then open it again."
        ) {
            HStack(spacing: 10) {
                Button("Open Applications Folder") {
                    NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications", isDirectory: true))
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.krakiPrimary)
                Button("Quit Kraki") { NSApp.terminate(nil) }
            }
        }
    }

    @ViewBuilder
    private var signIn: some View {
        switch runner.phase {
        case .idle, .failed:
            StepCard(
                title: "Set up this Mac",
                detail: "Sign in with GitHub to connect this Mac to your Kraki relay. Your coding agents here become available on your phone and other devices."
            ) {
                VStack(spacing: 10) {
                    Button {
                        runner.start(binaryPath: tentacleCLI.builtIn.binaryPath)
                    } label: {
                        Label("Sign in with GitHub", systemImage: "person.badge.key")
                            .frame(minWidth: 180, minHeight: 24)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.krakiPrimary)
                    .accessibilityIdentifier("mac.setup.signIn")
                    if case .failed(let message) = runner.phase {
                        Text(message)
                            .font(.system(size: 11))
                            .foregroundStyle(Color.orange)
                            .multilineTextAlignment(.center)
                    }
                }
            }
        case .starting:
            ProgressView("Contacting GitHub…").controlSize(.small)
        case .waitingForGitHub(let code, _):
            StepCard(
                title: "Enter this code on GitHub",
                detail: "The code is copied and GitHub is open in your browser. Paste it there and approve Kraki."
            ) {
                VStack(spacing: 12) {
                    Text(code)
                        .font(.system(size: 26, weight: .bold, design: .monospaced))
                        .tracking(3)
                        .textSelection(.enabled)
                        .foregroundStyle(Color.textTitle)
                        .accessibilityIdentifier("mac.setup.deviceCode")
                    HStack(spacing: 10) {
                        Button("Copy Code & Open GitHub") { runner.copyCodeAndOpenGitHub() }
                        Button("Cancel") { runner.cancel() }
                    }
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Waiting for approval…")
                            .font(.system(size: 10.5))
                            .foregroundStyle(Color.textMuted)
                    }
                }
            }
        case .configuring(let username), .done(let username):
            ProgressView(username.isEmpty ? "Setting up…" : "Signed in as \(username). Setting up…")
                .controlSize(.small)
        }
    }

    @ViewBuilder
    private var background: some View {
        switch tentacleCLI.daemonState {
        case .needsApproval:
            StepCard(
                title: "Allow Kraki in the background",
                detail: "Kraki is turned off in System Settings → General → Login Items. Turn Kraki on there so it can keep your agents connected."
            ) {
                HStack(spacing: 10) {
                    Button("Open Login Items") { BuiltInTentacle.openLoginItemsSettings() }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.krakiPrimary)
                    Button("Try Again") { Task { await tentacleCLI.startDaemon() } }
                }
            }
        case .error(let message):
            StepCard(title: "Kraki couldn't start", detail: message) {
                HStack(spacing: 10) {
                    Button("Try Again") { Task { await tentacleCLI.startDaemon() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.krakiPrimary)
                    Button("Show Logs") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: tentacleCLI.logsDirectory, isDirectory: true))
                    }
                }
            }
        default:
            ProgressView("Starting Kraki in the background…").controlSize(.small)
        }
    }

    private var fullDiskAccess: some View {
        StepCard(
            title: "Allow Full Disk Access",
            detail: "Your agents read and edit files across your projects. Give Kraki Full Disk Access once, and macOS won't interrupt them with permission prompts again."
        ) {
            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    Button("Open System Settings") { BuiltInTentacle.openFullDiskAccessSettings() }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.krakiPrimary)
                        .accessibilityIdentifier("mac.setup.openFDA")
                    Button("Later") { fdaSkipped = true }
                }
                Text("Turn on “Kraki” in the list. If macOS offers to quit and reopen Kraki, choose Quit & Reopen.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textMuted)
                    .multilineTextAlignment(.center)
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Waiting for access…")
                        .font(.system(size: 10.5))
                        .foregroundStyle(Color.textMuted)
                }
            }
        }
    }
}

private struct StepCard<Actions: View>: View {
    let title: String
    let detail: String
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 7) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text(detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Color.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            actions()
        }
    }
}

#endif
