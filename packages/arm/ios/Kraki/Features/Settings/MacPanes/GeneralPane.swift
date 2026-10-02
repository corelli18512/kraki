/// GeneralPane — App-wide appearance + window behavior preferences.

#if os(macOS)
import ServiceManagement
import SwiftUI

struct GeneralPane: View {
    @Environment(AppState.self) private var appState
    @AppStorage("colorScheme") private var colorScheme: AppColorScheme = .system
    @AppStorage("mac.keepRunningInMenuBar") private var keepRunningInMenuBar: Bool = true
    @State private var loginItem = LoginItemSetting()
    @ObservedObject private var usagePeek = UsagePeekController.shared

    var body: some View {
        Form {
            #if KRAKI_DIAG
            DiagSettingsSection()
            #endif
            Section("Appearance") {
                Picker("Theme", selection: $colorScheme) {
                    Text("System").tag(AppColorScheme.system)
                    Text("Light").tag(AppColorScheme.light)
                    Text("Dark").tag(AppColorScheme.dark)
                }
                .pickerStyle(.segmented)

                HStack(spacing: 6) {
                    ForEach([0xFBBF24, 0x34D399, 0x22D3EE, 0xF4836E, 0x6366F1], id: \.self) { hex in
                        Circle()
                            .fill(Color(hex: UInt(hex)))
                            .frame(width: 12, height: 12)
                    }
                    Text("Brand palette preview")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.textMuted)
                }
            }

            Section("Account Usage") {
                Toggle("Hold \(usagePeek.hotkey.shortcut.display) to peek at account usage", isOn: Binding(
                    get: { usagePeek.hotkey.enabled },
                    set: { usagePeek.hotkey.setEnabled($0) }))
                LabeledContent("Shortcut") {
                    UsageShortcutRecorder(manager: usagePeek.hotkey)
                        .frame(width: 230, height: 26)
                }
                Text("Click the shortcut to choose another key: F1–F20, or a combination with ⌘, ⌃ or ⌥. With Kraki in front the panel opens inside its window; over other apps it floats. \"Account Usage\" in the menu bar opens it any time.")
                    .font(.system(size: 11)).foregroundStyle(Color.textMuted)
                if let error = usagePeek.hotkey.error {
                    Text(error).font(.system(size: 11)).foregroundStyle(.orange)
                }
            }

            ArchiveSettingsSection()

            Section("Behavior") {
                Toggle("Keep running in menu bar when window closes", isOn: $keepRunningInMenuBar)
                Toggle("Open Kraki at login", isOn: Binding(
                    get: { loginItem.enabled },
                    set: { loginItem.set($0) }))
                    .help("Adds Kraki to your login items.")
                if loginItem.needsApproval {
                    HStack(spacing: 6) {
                        Text("Allow Kraki in System Settings › General › Login Items.")
                            .font(.system(size: 11)).foregroundStyle(.orange)
                        Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }
                            .controlSize(.small)
                    }
                }
                if let error = loginItem.error {
                    Text(error).font(.system(size: 11)).foregroundStyle(.orange)
                }
            }
        }
        .formStyle(.grouped)
        .onChange(of: colorScheme) { _, newValue in
            guard appState.preferencesManager?.isApplyingRemote != true else { return }
            appState.preferencesManager?.sendTheme(newValue)
        }
    }
}

/// "Open Kraki at login" backed by the system's own login item for this app.
@Observable
@MainActor
final class LoginItemSetting {
    private(set) var enabled: Bool
    private(set) var needsApproval: Bool
    private(set) var error: String?

    init() {
        let status = SMAppService.mainApp.status
        enabled = status == .enabled || status == .requiresApproval
        needsApproval = status == .requiresApproval
    }

    func set(_ on: Bool) {
        error = nil
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            self.error = on ? "Couldn't add Kraki to login items: \(error.localizedDescription)"
                            : "Couldn't remove Kraki from login items: \(error.localizedDescription)"
        }
        let status = SMAppService.mainApp.status
        enabled = status == .enabled || status == .requiresApproval
        needsApproval = status == .requiresApproval
    }
}

#endif
