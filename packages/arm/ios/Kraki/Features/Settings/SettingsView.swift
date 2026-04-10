#if os(iOS)
/// SettingsView — App settings matching the web sidebar settings panel.

import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState

    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system
    @AppStorage("notificationsEnabled") private var notificationsEnabled = true

    var body: some View {
        Form {
            accountSection
            appSection
            notificationsSection
            themeSection
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(Color.surfacePrimary)
    }

    // MARK: - Account

    private var accountSection: some View {
        Section("Account") {
            if let user = appState.user {
                HStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(Color.krakiPrimary.opacity(0.15))
                        Text(String(user.login.prefix(1)).uppercased())
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(Color.krakiPrimary)
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
        }
    }

    // MARK: - Notifications

    private var notificationsSection: some View {
        Section("Notifications") {
            Toggle("Push Notifications", isOn: $notificationsEnabled)
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
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Helpers

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

#endif
