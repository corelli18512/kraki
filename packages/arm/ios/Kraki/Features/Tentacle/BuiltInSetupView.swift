/// BuiltInSetupView — first-run setup with the tentacle built into the app.
///
/// Replaces "install the CLI and run `kraki connect`" for new users:
///
///   0. Location   — refuse to run from a translocated/disk-image path
///   1. This Mac   — which coding agents can run here (installed, signed in,
///                   models available) and Full Disk Access. Skippable: the
///                   user can use this Mac only to control other computers.
///   2. Sign in    — one click in the system web-auth window (device code as
///                   fallback), driven by `kraki setup --json --oauth`. Not
///                   skippable until a local-only mode exists.
///   3. Background — register the daemon with SMAppService (Login Items),
///                   unless step 1 was skipped
///
/// Every step is derived from live state (install location, stored choice,
/// config, daemon status), so relaunching the app — which System Settings
/// forces after a Full Disk Access grant — resumes at the right place.

#if os(macOS)
import AppKit
import SwiftUI

struct BuiltInSetupView: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @State private var runner = TentacleSetupRunner()
    @AppStorage(BuiltInTentacle.thisMacRoleKey) private var thisMacRole = BuiltInTentacle.ThisMacRole.undecided.rawValue
    @State private var finished = false
    @AppStorage("tentacle.movedFromCLI") private var movedFromCLI = false

    /// Called once the tentacle is configured and running; the caller retries
    /// the credential discovery that moves the app into the signed-in UI.
    let onFinished: () -> Void

    enum Step: Equatable {
        case detecting
        case moveToApplications(AppInstallLocation)
        /// A command-line install already runs Kraki: which one should?
        case chooseOwner
        /// Step 1: which agents can run here + Full Disk Access. Skippable.
        case thisMac
        /// Step 2: sign in.
        case signIn
        case background
        case done
    }

    static func step(
        installState: TentacleCLIManager.InstallState,
        location: AppInstallLocation,
        configured: Bool,
        daemonState: TentacleCLIManager.DaemonState,
        role: BuiltInTentacle.ThisMacRole,
        ownerChoicePending: Bool = false,
        movedFromCLI: Bool = false
    ) -> Step {
        if case .unknown = installState { return .detecting }
        if location != .stable { return .moveToApplications(location) }
        if ownerChoicePending { return .chooseOwner }
        // Existing installs (configured before this step existed) skip it;
        // someone who just moved over from the CLI still needs it (agents and
        // Full Disk Access for Kraki for Mac), but not a new sign-in.
        if role == .undecided, !configured || movedFromCLI { return .thisMac }
        // Sign-in cannot be skipped yet: every Kraki client needs an account
        // today. Once a local-only mode exists (use this Mac's agents without
        // an account), make this step skippable too.
        if !configured { return .signIn }
        if role == .remoteOnly { return .done }
        guard case .running = daemonState else { return .background }
        return .done
    }

    private var role: BuiltInTentacle.ThisMacRole {
        BuiltInTentacle.ThisMacRole(rawValue: thisMacRole) ?? .undecided
    }

    private var currentStep: Step {
        if case .done = runner.phase, tentacleCLI.configInfo?.exists != true {
            // Config was just written; the next status poll will confirm it.
            return .signIn
        }
        return Self.step(
            installState: tentacleCLI.installState,
            location: tentacleCLI.installLocation,
            configured: tentacleCLI.configInfo?.exists == true,
            daemonState: tentacleCLI.daemonState,
            role: role,
            ownerChoicePending: tentacleCLI.ownerChoicePending,
            movedFromCLI: movedFromCLI
        )
    }

    var body: some View {
        VStack(spacing: 14) {
            switch currentStep {
            case .detecting:
                ProgressView().controlSize(.small)
            case .moveToApplications(let location):
                moveToApplications(location)
            case .chooseOwner:
                ExistingCLIChoiceView(embedded: true) { mode in
                    if mode == .builtIn {
                        movedFromCLI = true
                    } else {
                        // Keep the CLI: it is signed in, go straight in.
                        finished = true
                        onFinished()
                    }
                }
            case .thisMac:
                ThisMacSetupStep(
                    binaryPath: tentacleCLI.builtIn.binaryPath,
                    stepLabel: movedFromCLI ? nil : "Step 1 of 2",
                    onContinue: { thisMacRole = BuiltInTentacle.ThisMacRole.runsAgents.rawValue; movedFromCLI = false },
                    onSkip: {
                        movedFromCLI = false
                        // Also stops a daemon the move from the CLI already started.
                        Task { await tentacleCLI.setRunsAgentsOnThisMac(false) }
                    }
                )
            case .signIn:
                signIn
            case .background:
                background
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
                if role != .remoteOnly { await tentacleCLI.startDaemon() }
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
                step: "Step 2 of 2",
                title: "Sign in",
                detail: "Sign in with GitHub. The coding agents on this Mac become available here, on your phone and on your other computers."
            ) {
                VStack(spacing: 10) {
                    Button {
                        runner.start(binaryPath: tentacleCLI.builtIn.binaryPath)
                    } label: {
                        HStack(spacing: 8) {
                            GitHubMark().frame(width: 16, height: 16)
                            Text("Sign in with GitHub")
                                .font(.system(size: 13, weight: .medium))
                        }
                        .foregroundStyle(.white)
                        .frame(minWidth: 200, minHeight: 32)
                        .background(Color(red: 0.141, green: 0.161, blue: 0.184), in: RoundedRectangle(cornerRadius: 8)) // #24292f, same as web/iOS
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("mac.setup.signIn")
                    if case .failed(let message) = runner.phase {
                        Text(message)
                            .font(.system(size: 11))
                            .foregroundStyle(Color.orange)
                            .multilineTextAlignment(.center)
                        Button("Sign in with a code instead") { runner.startWithCode() }
                            .buttonStyle(.link)
                            .font(.system(size: 10.5))
                    }
                }
            }
        case .starting:
            ProgressView("Contacting GitHub…").controlSize(.small)
        case .waitingForBrowser:
            StepCard(
                step: "Step 2 of 2",
                title: "Continue in the sign-in window",
                detail: "Approve Kraki on GitHub. If you're already signed in to GitHub, that's one click."
            ) {
                VStack(spacing: 10) {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Waiting for GitHub…")
                            .font(.system(size: 10.5))
                            .foregroundStyle(Color.textMuted)
                    }
                    HStack(spacing: 10) {
                        Button("Show Sign-in Window") { runner.reopenBrowser() }
                        Button("Cancel") { runner.cancel() }
                    }
                    Button("Sign in with a code instead") { runner.startWithCode() }
                        .buttonStyle(.link)
                        .font(.system(size: 10.5))
                }
            }
        case .waitingForGitHub(let code, _):
            StepCard(
                step: "Step 2 of 2",
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
                title: "Let this Mac stay online",
                detail: "Kraki is turned off in System Settings → General → Login Items. Turn Kraki on there so your phone and other computers can use the agents on this Mac."
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
                    if message == TentacleCLIManager.launchdStuckMessage {
                        // macOS's own "Are you sure you want to restart?" dialog.
                        Button("Restart Mac…") {
                            NSAppleScript(source: "tell application \"loginwindow\" to «event aevtrrst»")?.executeAndReturnError(nil)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.krakiPrimary)
                    }
                    if message == TentacleCLIManager.launchdStuckMessage {
                        Button("Try Again") { Task { await tentacleCLI.startDaemon() } }
                    } else {
                        Button("Try Again") { Task { await tentacleCLI.startDaemon() } }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.krakiPrimary)
                    }
                    Button("Show Logs") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: tentacleCLI.logsDirectory, isDirectory: true))
                    }
                }
            }
        default:
            ProgressView("Bringing this Mac online…").controlSize(.small)
        }
    }
}

struct StepCard<Actions: View>: View {
    var step: String? = nil
    let title: String
    let detail: String
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 7) {
                if let step {
                    Text(step.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.8)
                        .foregroundStyle(Color.krakiPrimary)
                }
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
