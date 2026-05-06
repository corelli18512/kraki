#if os(iOS)
/// DeviceListView — Native iOS device list with small inline title.

import SwiftUI

struct DeviceListView: View {
    @Environment(AppState.self) private var appState

    private var tentacles: [DeviceSummary] {
        appState.deviceStore.devices.values
            .filter { $0.role == .tentacle }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private var onlineDevices: [DeviceSummary] {
        tentacles.filter(\.online)
    }

    private var offlineDevices: [DeviceSummary] {
        tentacles.filter { !$0.online }
    }

    var body: some View {
        Group {
            if tentacles.isEmpty {
                emptyState
            } else {
                deviceList
            }
        }
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.inline)
        .background(Color.surfacePrimary)
        .navigationDestination(for: DeviceNavID.self) { nav in
            if let device = appState.deviceStore.devices[nav.id] {
                DeviceDetailView(device: device)
            }
        }
    }

    // MARK: - Device List

    private var deviceList: some View {
        List {
            if !onlineDevices.isEmpty {
                Section("Online") {
                    ForEach(onlineDevices) { device in
                        NavigationLink(value: DeviceNavID(id: device.id)) {
                            DeviceRow(
                                device: device,
                                isSelf: device.id == appState.deviceId,
                                hasGreeting: appState.deviceStore.deviceModels[device.id] != nil
                            )
                        }
                    }
                }
            }

            if !offlineDevices.isEmpty {
                Section("Offline") {
                    ForEach(offlineDevices) { device in
                        NavigationLink(value: DeviceNavID(id: device.id)) {
                            DeviceRow(
                                device: device,
                                isSelf: device.id == appState.deviceId,
                                hasGreeting: false
                            )
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 0)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()

            Text("📡")
                .font(.system(size: 40))

            Text("No devices connected")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            (Text("Run ") + Text("kraki connect").monospaced() + Text(" to pair a device."))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)

            Spacer()
        }
        .padding(.horizontal, 32)
    }
}

// MARK: - Device Row

private struct DeviceRow: View {
    let device: DeviceSummary
    let isSelf: Bool
    let hasGreeting: Bool

    private var dotColor: Color {
        if device.online && hasGreeting { return Color(hex: 0x34D399) }
        if device.online { return Color(hex: 0xFBBF24) }
        return Color(hex: 0x94A3B8)
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)

            Text(device.name)
                .font(.body)

            Spacer()

            if isSelf {
                Text("You")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.krakiPrimary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.krakiPrimary.opacity(0.15), in: Capsule())
            }
        }
    }
}

#endif
