/// SettingsView — App settings matching the web sidebar settings panel.
///
/// Shows account info, app version, theme picker, debug toggle, and sign-out.

import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState

    @AppStorage("debugLogging") private var debugLogging = false
    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system
    @State private var showSignOutConfirmation = false

    var body: some View {
        Form {
            accountSection
            appSection
            themeSection
            dangerSection
        }
        .navigationTitle("Settings")
        .alert("Sign Out", isPresented: $showSignOutConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Sign Out", role: .destructive) {
                signOut()
            }
        } message: {
            Text("This will clear your credentials and disconnect from the relay. You'll need to sign in again.")
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section("Account") {
            if let user = appState.user {
                HStack(spacing: 12) {
                    // Avatar placeholder
                    ZStack {
                        Circle()
                            .fill(Color.krakiPrimary.opacity(0.15))
                        Text(String(user.login.prefix(1)).uppercased())
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(.krakiPrimary)
                    }
                    .frame(width: 40, height: 40)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.login)
                            .font(.body.weight(.medium))
                        if let provider = user.provider {
                            Text(provider)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                LabeledContent("Relay URL") {
                    Text(appState.relayURL)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else {
                Text("Not signed in")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - App

    private var appSection: some View {
        Section("App") {
            LabeledContent("App Version") {
                Text(appVersion)
                    .foregroundStyle(.secondary)
            }

            if let relayVersion = appState.relayVersion {
                LabeledContent("Relay Version") {
                    Text(relayVersion)
                        .foregroundStyle(.secondary)
                }
            }

            Toggle("Debug Logging", isOn: $debugLogging)
        }
    }

    // MARK: - Theme

    private var themeSection: some View {
        Section("Theme") {
            Picker("Appearance", selection: $selectedScheme) {
                Text("System").tag(AppColorScheme.system)
                Text("Light").tag(AppColorScheme.light)
                Text("Dark").tag(AppColorScheme.dark)
            }
        }
    }

    // MARK: - Danger Zone

    private var dangerSection: some View {
        Section("Danger Zone") {
            Button(role: .destructive) {
                showSignOutConfirmation = true
            } label: {
                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        }
    }

    // MARK: - Actions

    private func signOut() {
        do {
            try KeychainManager().deleteAllKeys()
        } catch {
            // Best-effort keychain cleanup
        }

        appState.disconnect()
        appState.sessionStore.reset()
        appState.deviceStore.reset()
        appState.messageStore.reset()
        appState.deviceId = nil
        appState.user = nil
        appState.connectionStatus = .awaitingLogin
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
        if let build {
            return "\(version) (\(build))"
        }
        return version
    }
}

// MARK: - AppColorScheme

enum AppColorScheme: String, CaseIterable {
    case system
    case light
    case dark

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
