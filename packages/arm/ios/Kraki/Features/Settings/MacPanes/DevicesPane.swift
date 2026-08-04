/// DevicesPane — Paired devices list (read-only for now).
///
/// Full device management (rename, revoke) lives in DeviceDetailView
/// reachable from the sidebar Devices section. This pane is a quick
/// overview.

#if os(macOS)
import SwiftUI

struct DevicesPane: View {
    @Environment(AppState.self) private var appState

    private var devices: [DeviceSummary] {
        appState.deviceStore.devices.values
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        Form {
            Section("Paired devices") {
                if devices.isEmpty {
                    Text("No paired devices.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(devices) { device in
                        DeviceRow(device: device)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct DeviceRow: View {
    let device: DeviceSummary
    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(device.online ? Color(hex: 0x34D399) : Color.textMuted.opacity(0.5))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textPrimary)
                Text(device.role.rawValue.capitalized)
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(0.4)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.textMuted)
            }
            Spacer()
            Text(String(device.id.prefix(10)) + "…")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color.textMuted)
                .help(device.id)
        }
        .padding(.vertical, 4)
    }
}

#endif
