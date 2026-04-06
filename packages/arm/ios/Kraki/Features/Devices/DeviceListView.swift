#if os(iOS)
/// DeviceListView — NavigationStack list of devices grouped by online status.
///
/// Mirrors the mobile column of DeviceGrid.tsx. Shows tentacle devices
/// with status indicators, "You" badge, and links to DeviceDetailView.

import SwiftUI

struct DeviceListView: View {
    @Environment(AppState.self) private var appState

    private var devices: [DeviceSummary] {
        appState.deviceStore.devices.values
            .filter { $0.role == .tentacle }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private var onlineDevices: [DeviceSummary] {
        devices.filter(\.online)
    }

    private var offlineDevices: [DeviceSummary] {
        devices.filter { !$0.online }
    }

    var body: some View {
        Group {
            if devices.isEmpty {
                emptyState
            } else {
                deviceList
            }
        }
        .navigationTitle("Devices")
    }

    // MARK: - Device List

    private var deviceList: some View {
        List {
            if !onlineDevices.isEmpty {
                Section("Online") {
                    ForEach(onlineDevices) { device in
                        NavigationLink(value: device.id) {
                            DeviceRow(
                                device: device,
                                isCurrentDevice: device.id == appState.deviceId,
                                hasGreeting: appState.deviceStore.deviceModels[device.id] != nil
                            )
                        }
                    }
                }
            }

            if !offlineDevices.isEmpty {
                Section("Offline") {
                    ForEach(offlineDevices) { device in
                        NavigationLink(value: device.id) {
                            DeviceRow(
                                device: device,
                                isCurrentDevice: device.id == appState.deviceId,
                                hasGreeting: false
                            )
                        }
                    }
                }
            }
        }
        .navigationDestination(for: String.self) { deviceId in
            if let device = appState.deviceStore.devices[deviceId] {
                DeviceDetailView(device: device)
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Devices", systemImage: "antenna.radiowaves.left.and.right")
        } description: {
            Text("Run **kraki connect** in your terminal to pair a new device.")
        }
    }
}

// MARK: - Device Row

private struct DeviceRow: View {
    let device: DeviceSummary
    let isCurrentDevice: Bool
    let hasGreeting: Bool

    private var dotColor: Color {
        if device.online && hasGreeting { return .green }
        if device.online { return .orange }
        return .gray
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                    .font(.body)

                if device.role == .tentacle {
                    Text("tentacle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if isCurrentDevice {
                Text("You")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.blue)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.blue.opacity(0.12))
                    .clipShape(Capsule())
            }
        }
    }
}

#endif
