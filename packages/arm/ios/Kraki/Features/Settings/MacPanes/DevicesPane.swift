/// DevicesPane — Paired devices list (read-only for now).
///
/// Full device management (rename, revoke) lives in DeviceDetailView
/// reachable from the sidebar Devices section. This pane is a quick
/// overview.

#if os(macOS)
import SwiftUI

struct DevicesPane: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @State private var showingPairing = false

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
                        DeviceRow(device: device,
                                  version: appState.deviceStore.displayVersion(for: device.id),
                                  update: appState.deviceStore.availableUpdate(for: device.id),
                                  hasProgress: appState.deviceStore.updateProgress[device.id] != nil,
                                  isThisMac: device.id == tentacleCLI.configInfo?.deviceId)
                    }
                }
            }
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "iphone")
                        .font(.system(size: 20))
                        .foregroundStyle(Color.krakiPrimary)
                        .frame(width: 26)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Use Kraki on your phone")
                            .font(.system(size: 13, weight: .medium))
                        Text("Scan a code with your phone to see and run your sessions there.")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Show Code…") { showingPairing = true }
                    .accessibilityIdentifier("prefs.devices.addPhone")
                }
                .padding(.vertical, 4)
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $showingPairing) { PairingSheet() }
    }
}

private struct DeviceRow: View {
    let device: DeviceSummary
    var version: String?
    var update: AvailableUpdate?
    var hasProgress = false
    var isThisMac = false
    var body: some View {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 10) {
            Circle()
                .fill(device.online ? Color(hex: 0x34D399) : Color.textMuted.opacity(0.5))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textPrimary)
                HStack(spacing: 6) {
                    Text(device.role.displayName)
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.4)
                        .textCase(.uppercase)
                    if let version, device.role == .tentacle {
                        Text(version).font(.system(size: 10.5))
                    }
                }
                .foregroundStyle(Color.textMuted)
            }
            Spacer()
            Text(String(device.id.prefix(10)) + "…")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color.textMuted)
                .help(device.id)
        }
        if update != nil || hasProgress {
            DeviceUpdateControl(device: device, isThisMac: isThisMac)
                .padding(.leading, 18)
        }
      }
        .padding(.vertical, 4)
    }
}

#endif
