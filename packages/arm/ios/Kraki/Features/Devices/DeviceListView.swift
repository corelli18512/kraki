#if os(iOS)
/// DeviceListView — Matches web DeviceGrid.tsx mobile column.
///
/// Shows tentacle devices as rounded bordered buttons with status dots,
/// navigating to DeviceDetailView on tap.

import SwiftUI

struct DeviceListView: View {
    @Environment(AppState.self) private var appState

    @State private var selectedDeviceId: String?

    private var tentacles: [DeviceSummary] {
        appState.deviceStore.devices.values
            .filter { $0.role == .tentacle }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
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
        .scrollContentBackground(.hidden)
        .background(Color.surfacePrimary)
        .navigationDestination(for: String.self) { deviceId in
            if let device = appState.deviceStore.devices[deviceId] {
                DeviceDetailView(device: device)
            }
        }
    }

    // MARK: - Device List

    private var deviceList: some View {
        ScrollView {
            VStack(spacing: 6) {
                ForEach(tentacles) { device in
                    NavigationLink(value: device.id) {
                        DeviceButton(
                            device: device,
                            hasGreeting: appState.deviceStore.deviceModels[device.id] != nil,
                            isSelected: selectedDeviceId == device.id,
                            isSelf: device.id == appState.deviceId
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()

            Text("📡")
                .font(.system(size: 40))

            Text("No devices connected")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundStyle(.primary)

            Text("Run ")
                .font(.caption)
                .foregroundStyle(.secondary)
            + Text("kraki connect")
                .font(.caption)
                .monospaced()
                .foregroundStyle(.secondary)
            + Text(" in your terminal to pair a new device.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
    }
}

// MARK: - Device Button (matches web DeviceButton)

private struct DeviceButton: View {
    let device: DeviceSummary
    let hasGreeting: Bool
    let isSelected: Bool
    let isSelf: Bool

    private var dotColor: Color {
        if device.online && hasGreeting { return Color(hex: 0x34D399) } // emerald-400
        if device.online { return Color(hex: 0xFBBF24) }               // amber-400
        return Color(hex: 0x94A3B8)                                      // slate-400
    }

    private var dotPulses: Bool {
        device.online && !hasGreeting
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
                .opacity(dotPulses ? 0.8 : 1)
                .animation(dotPulses ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : .default, value: dotPulses)

            Text(device.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isSelected ? Color.textPrimary : Color.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer()

            if isSelf {
                Text("You")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color.krakiPrimary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.krakiPrimary.opacity(0.15), in: Capsule())
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isSelected ? Color.surfaceTertiary : Color.surfaceSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.borderPrimary, lineWidth: 1)
        )
    }
}

#endif
