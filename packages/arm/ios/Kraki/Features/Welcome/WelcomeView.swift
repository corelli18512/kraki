/// WelcomeView — Empty/idle state shown in the detail pane when no
/// session is selected.
///
/// Adapts content to the current state of:
///   1. TentacleCLIManager.installState  — is kraki installed at all?
///   2. TentacleCLIManager.daemonState   — is the local tentacle running?
///   3. appState.sessionStore.sessions   — do we have any sessions yet?
///
/// The three states cascade: install issues come first, then daemon,
/// then "select a session" / "pair a device".

#if os(macOS)
import SwiftUI

struct WelcomeView: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 18) {
            Spacer()

            Image("KrakiLogo")
                .resizable()
                .interpolation(.high)
                .frame(width: 120, height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .shadow(color: Color.black.opacity(0.18), radius: 22, y: 10)

            VStack(spacing: 6) {
                Text("KRAKI")
                    .font(.system(size: 22, weight: .heavy, design: .monospaced))
                    .tracking(4)
                    .foregroundStyle(Color.textTitle)
                Text("Multi-device · Multi-agent · Coding")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(0.3)
                    .foregroundStyle(Color.textMuted)
                    .textCase(.uppercase)
            }

            content
                .frame(maxWidth: 460)
                .padding(.top, 12)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
        .background(Color.surfacePrimary)
    }

    @ViewBuilder
    private var content: some View {
        // This app is an Arm first: remote relay sessions remain fully usable
        // whether or not this Mac is also running a local Tentacle daemon.
        // Local Tentacle lifecycle belongs in Preferences and must never mask
        // an already-synced session list with a blocking stopped-state card.
        if !appState.sessionStore.sessions.isEmpty {
            selectSessionCard
        } else if appState.devLocalActive {
            devLocalContent
        } else {
            switch appState.connectionStatus {
            case .connected:
                noSessionsCard
            case .awaitingLogin, .connecting, .authenticating:
                ProgressView("Connecting to Kraki…")
                    .controlSize(.small)
            case .disconnected, .error:
                localTentacleSetupContent
            }
        }
    }

    @ViewBuilder
    private var localTentacleSetupContent: some View {
        switch tentacleCLI.installState {
        case .unknown:
            ProgressView("Detecting kraki…")
                .controlSize(.small)
        case .notFound:
            notInstalledCard
        case .available:
            installedContent
        }
    }

    // MARK: - Dev-local branch
    //
    // In dev-local mode (KRAKI_DEV_LOCAL=1) the app is a client of the
    // `pnpm dev` relay, NOT the global kraki CLI. Drive the empty state
    // off the live relay connection instead of `tentacleCLI` (which
    // shells out to the user's global `kraki status` and is unrelated
    // to the dev stack).
    @ViewBuilder
    private var devLocalContent: some View {
        switch appState.connectionStatus {
        case .connected:
            if appState.sessionStore.sessions.isEmpty {
                devLocalNoSessionsCard
            } else {
                selectSessionCard
            }
        case .awaitingLogin, .connecting, .authenticating:
            ProgressView("Connecting to local dev stack…")
                .controlSize(.small)
        case .disconnected, .error:
            devLocalDisconnectedCard
        }
    }

    private var devLocalNoSessionsCard: some View {
        WelcomeCard(
            icon: "bolt.horizontal.circle.fill",
            iconColor: Color.krakiPrimary,
            title: "Connected to local dev stack",
            subtitle: "You're on the pnpm dev relay with an isolated home. Start a session with ⌘N, or run kraki in a terminal against the dev daemon."
        ) {
            Button {
                NotificationCenter.default.post(name: .macOpenNewSession, object: nil)
            } label: {
                Label("New Session", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.krakiPrimary)
        }
    }

    private var devLocalDisconnectedCard: some View {
        WelcomeCard(
            icon: "antenna.radiowaves.left.and.right.slash",
            iconColor: Color(hex: 0xFBBF24),
            title: "Local dev relay unreachable",
            subtitle: "Start the local full stack with `pnpm dev`, then it will connect automatically."
        ) {
            Button("Retry connection") {
                appState.devConnect()
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.krakiPrimary)
        }
    }

    // MARK: - Not installed

    private var notInstalledCard: some View {
        WelcomeCard(
            icon: "exclamationmark.triangle.fill",
            iconColor: Color(hex: 0xFBBF24),
            title: "Kraki CLI not found",
            subtitle: "Install the kraki command-line tool in Terminal, then come back here."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "terminal")
                        .foregroundStyle(Color.krakiPrimary)
                    Text("npm install -g @kraki/cli")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .foregroundStyle(Color.textPrimary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.surfaceTertiary)
                )

                HStack(spacing: 10) {
                    Button("Locate kraki manually…") {
                        Task { await locateManually() }
                    }
                    Button("Open Documentation") {
                        openURL(URL(string: "https://kraki.chat/docs/install")!)
                    }
                    .buttonStyle(.bordered)

                    Spacer()

                    Button("Re-check") {
                        Task { await tentacleCLI.refreshInstallState() }
                    }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.textMuted)
                }
            }
        }
    }

    // MARK: - Installed branch

    @ViewBuilder
    private var installedContent: some View {
        switch tentacleCLI.daemonState {
        case .unknown, .starting, .stopping:
            ProgressView("Talking to tentacle…")
                .controlSize(.small)
        case .stopped:
            daemonStoppedCard
        case .error(let msg):
            daemonErrorCard(msg)
        case .running:
            if appState.sessionStore.sessions.isEmpty {
                noSessionsCard
            } else {
                selectSessionCard
            }
        }
    }

    private var daemonStoppedCard: some View {
        WelcomeCard(
            icon: "moon.zzz.fill",
            iconColor: Color.textMuted,
            title: "Tentacle is stopped",
            subtitle: "Start the local kraki daemon to connect this Mac as a tentacle."
        ) {
            HStack {
                Button {
                    Task { await tentacleCLI.startDaemon() }
                } label: {
                    Label("Start tentacle", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.krakiPrimary)

                Button("Open Preferences") {
                    openSettings()
                }
            }
        }
    }

    private func daemonErrorCard(_ msg: String) -> some View {
        WelcomeCard(
            icon: "xmark.octagon.fill",
            iconColor: Color(hex: 0xF4836E),
            title: "Tentacle error",
            subtitle: msg
        ) {
            HStack {
                Button("Retry") {
                    Task { await tentacleCLI.startDaemon() }
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.krakiPrimary)
                Button("Show Logs") {
                    NSWorkspace.shared.open(
                        URL(fileURLWithPath: tentacleCLI.logsDirectory, isDirectory: true)
                    )
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var noSessionsCard: some View {
        WelcomeCard(
            icon: "qrcode",
            iconColor: Color.krakiPrimary,
            title: "Pair a device",
            subtitle: "Show this pairing code to your phone or another Mac to join your relay."
        ) {
            Button {
                Task { await requestPairing() }
            } label: {
                Label("Generate pairing code", systemImage: "qrcode")
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.krakiPrimary)
        }
    }

    private var selectSessionCard: some View {
        VStack(spacing: 8) {
            Text("Select a session in the sidebar")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
            Text("Or press ⌘N to start a new one.")
                .font(.system(size: 11))
                .foregroundStyle(Color.textMuted)
        }
    }

    // MARK: - Actions

    private func locateManually() async {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.title = "Locate kraki executable"
        panel.message = "Pick the kraki binary in your filesystem."
        panel.directoryURL = URL(fileURLWithPath: "/usr/local/bin")
        if panel.runModal() == .OK, let url = panel.url {
            tentacleCLI.setBinaryPathOverride(url.path)
            await tentacleCLI.refreshInstallState()
        }
    }

    private func requestPairing() async {
        NotificationCenter.default.post(name: .macOpenPairing, object: nil)
    }
}

// MARK: - Card chrome

private struct WelcomeCard<Content: View>: View {
    let icon: String
    var iconColor: Color = .krakiPrimary
    let title: String
    let subtitle: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(iconColor.opacity(0.15))
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(iconColor)
                }
                .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.surfaceSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.borderPrimary.opacity(0.5), lineWidth: 1)
        )
    }
}

#endif
