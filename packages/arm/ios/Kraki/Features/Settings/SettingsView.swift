#if os(iOS)
/// SettingsView — App settings matching the web sidebar settings panel.

import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppState.self) private var appState

    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system
    @State private var pushToggle: Bool = false
    @State private var pushBusy: Bool = false

    var body: some View {
        Form {
            accountSection
            notificationsSection
            themeSection
            relaySection
        }
        .formStyle(.grouped)
        .contentMargins(.top, 0)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(Color.surfacePrimary)
        .environment(\.defaultMinListHeaderHeight, 0)
        .task {
            await appState.pushManager?.refreshPermissionStatus()
            pushToggle = (appState.pushManager?.userEnabled ?? false)
                && (appState.pushManager?.permissionStatus == .authorized
                    || appState.pushManager?.permissionStatus == .provisional
                    || appState.pushManager?.permissionStatus == .ephemeral)
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section {
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
            } else {
                Text("Not signed in")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Notifications

    private var notificationsSection: some View {
        Section {
            Toggle("Push Notifications", isOn: Binding(
                get: { pushToggle },
                set: { newValue in handlePushToggle(newValue) }
            ))
            .disabled(pushBusy)

            if let status = appState.pushManager?.permissionStatus {
                pushStatusRow(status)
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("Push notifications are end-to-end encrypted. The relay forwards an opaque blob; this device decrypts and shows it locally.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func pushStatusRow(_ status: UNAuthorizationStatus) -> some View {
        switch status {
        case .denied:
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                HStack {
                    Text("Permission denied")
                        .foregroundStyle(.red)
                    Spacer()
                    Text("Open Settings")
                        .foregroundStyle(Color.krakiPrimary)
                }
            }
        case .authorized, .provisional, .ephemeral:
            if pushToggle, appState.pushManager?.registered == true {
                LabeledContent("Status") {
                    Text("Registered")
                        .foregroundStyle(.green)
                }
            } else if pushToggle {
                LabeledContent("Status") {
                    Text("Registering…")
                        .foregroundStyle(.secondary)
                }
            }
        case .notDetermined:
            EmptyView()
        @unknown default:
            EmptyView()
        }
    }

    private func handlePushToggle(_ newValue: Bool) {
        guard let push = appState.pushManager else { return }
        pushBusy = true
        Task {
            if newValue {
                let granted = await push.enable()
                pushToggle = granted
            } else {
                push.disable()
                pushToggle = false
            }
            pushBusy = false
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

    // MARK: - Relay

    private var relaySection: some View {
        Section {
            LabeledContent("URL") {
                Text(appState.relayURL)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if let relayVersion = appState.relayVersion {
                LabeledContent("Version") {
                    Text(relayVersion)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Relay")
        } footer: {
            HStack(spacing: 8) {
                Image("KrakiLogo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text("Kraki for iOS \(appVersion)")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 12)
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
