/// GeneralPane — App-wide appearance + window behavior preferences.

#if os(macOS)
import SwiftUI

struct GeneralPane: View {
    @AppStorage("colorScheme") private var colorScheme: AppColorScheme = .system
    @AppStorage("mac.keepRunningInMenuBar") private var keepRunningInMenuBar: Bool = true
    @AppStorage("mac.openAtLogin") private var openAtLogin: Bool = false

    var body: some View {
        Form {
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

            Section("Behavior") {
                Toggle("Keep running in menu bar when window closes", isOn: $keepRunningInMenuBar)
                Toggle("Open Kraki at login", isOn: $openAtLogin)
                    .help("Adds Kraki to your login items.")
                    .disabled(true) // TODO: SMAppService integration
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

#endif
