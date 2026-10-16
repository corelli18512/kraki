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

    /// Usage is optional: most people never sign a Claude or Codex
    /// subscription in on their computers. Show the section only when at least
    /// one account has reported, never as an empty card with a Refresh button.
    static func showsAccounts(_ store: DeviceStore) -> Bool {
        !store.mergedUsage().isEmpty
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
                                hasGreeting: !appState.deviceStore.agents(for: device.id).isEmpty
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

            // Subscription usage is secondary to the computers themselves, and
            // per account (merged across devices): it follows the device list.
            let accounts = appState.deviceStore.mergedUsage()
            if !accounts.isEmpty {
                let outdated = appState.deviceStore.devicesNeedingUsageUpdate()
                Section {
                    AccountUsageRefreshControls()
                    ForEach(Array(accounts.enumerated()), id: \.element.id) { index, merged in
                        AccountUsageRow(merged: merged, delay: 0.05 + Double(index) * 0.04)
                    }
                } header: {
                    Text("Accounts")
                } footer: {
                    if outdated.isEmpty {
                        Text("Claude and Codex subscriptions signed in on your devices. An account shared by several devices is shown once.")
                    } else {
                        Label(UsageUpdateHint.text(outdated), systemImage: "arrow.down.circle")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 0)
        .task(id: appState.connectionStatus == .connected ? appState.deviceStore.usageRefreshTargets() : []) {
            // Retry when a greeting/connection arrives after appearance. SwiftUI
            // cancels this task when the page leaves the screen.
            guard !Task.isCancelled else { return }
            appState.commandSender?.refreshAccountUsage(automatic: true)
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()

            Text("📡")
                .font(.system(size: 40))

            Text("No computers yet")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            (Text("Install Kraki on the computer that runs your coding agents, then run ")
                + Text("kraki connect").monospaced() + Text(" there and scan the code."))
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
    @Environment(AppState.self) private var appState
    let device: DeviceSummary
    let isSelf: Bool
    let hasGreeting: Bool

    private var dotColor: Color {
        // When the iOS client itself is not connected to the relay we
        // can't trust any device's online state — show everything in
        // warning orange to make the staleness visible.
        if !appState.isFullyOnline { return Color(hex: 0xFBBF24) }
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
                    .scaledFont(10, weight: .semibold)
                    .foregroundStyle(Color.krakiPrimary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.krakiPrimary.opacity(0.15), in: Capsule())
            }
        }
    }
}

#endif
