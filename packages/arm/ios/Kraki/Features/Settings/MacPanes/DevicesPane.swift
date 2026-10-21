/// DevicesPane — the account's devices: online state, version, updates,
/// renaming any of them, and removing an old device (like iPhone's Remove
/// Device and the web's Remove).

#if os(macOS)
import SwiftUI

struct DevicesPane: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @State private var showingPairing = false
    @State private var removing: DeviceSummary?
    @State private var renaming: DeviceSummary?
    @State private var nameDraft = ""

    private var devices: [DeviceSummary] {
        appState.deviceStore.devices.values
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        Form {
            Section("Devices") {
                if devices.isEmpty {
                    Text("No devices.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(devices) { device in
                        DeviceRow(device: device,
                                  version: appState.deviceStore.displayVersion(for: device.id),
                                  update: appState.deviceStore.availableUpdate(for: device.id),
                                  hasProgress: appState.deviceStore.updateProgress[device.id] != nil,
                                  isThisMac: device.id == tentacleCLI.configInfo?.deviceId,
                                  canRemove: Self.canRemove(device, appDeviceId: appState.deviceId,
                                                            thisMacDeviceId: tentacleCLI.configInfo?.deviceId),
                                  onRemove: { removing = device },
                                  onRename: { nameDraft = device.name; renaming = device })
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
        .alert(
            "Rename \(renaming?.name ?? "device")",
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
        ) {
            TextField(renaming?.ownName ?? "", text: $nameDraft)
                .accessibilityIdentifier("prefs.devices.renameField")
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Save") {
                if let device = renaming, let name = DeviceName.renameValue(draft: nameDraft, for: device) {
                    appState.commandSender?.renameDevice(deviceId: device.id, name: name)
                }
                renaming = nil
            }
        } message: {
            Text("Shown on all your devices. Leave it empty to use \"\(renaming?.ownName ?? "")\".")
        }
        .alert(
            "Remove \(removing?.name ?? "device")?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
        ) {
            Button("Cancel", role: .cancel) { removing = nil }
            Button("Remove", role: .destructive) {
                if let id = removing?.id { appState.commandSender?.removeDevice(deviceId: id) }
                removing = nil
            }
        } message: {
            Text("It's signed out of your account. To use it again, sign in or pair it again.")
        }
    }

    /// Same rule as iPhone: an offline device that is neither this app nor
    /// the Kraki built into this Mac.
    static func canRemove(_ device: DeviceSummary, appDeviceId: String?, thisMacDeviceId: String?) -> Bool {
        !device.online && device.id != appDeviceId && device.id != thisMacDeviceId
    }
}

private struct DeviceRow: View {
    /// "today", "yesterday", "Sep 28" (relay dates: ISO 8601 or SQLite UTC).
    static func lastOnline(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = iso.date(from: raw)
        if date == nil { iso.formatOptions = [.withInternetDateTime]; date = iso.date(from: raw) }
        if date == nil {
            let sql = DateFormatter()
            sql.locale = Locale(identifier: "en_US_POSIX")
            sql.timeZone = TimeZone(identifier: "UTC")
            sql.dateFormat = "yyyy-MM-dd HH:mm:ss"
            date = sql.date(from: raw)
        }
        guard let date else { return nil }
        if Calendar.current.isDateInToday(date) { return "today" }
        if Calendar.current.isDateInYesterday(date) { return "yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    let device: DeviceSummary
    var version: String?
    var update: AvailableUpdate?
    var hasProgress = false
    var isThisMac = false
    var canRemove = false
    var onRemove: () -> Void = {}
    var onRename: () -> Void = {}
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
                    if !device.online, let seen = Self.lastOnline(device.lastSeen) {
                        Text("Last online \(seen)").font(.system(size: 10.5))
                    }
                }
                .foregroundStyle(Color.textMuted)
            }
            Spacer()
            Button("Rename…", action: onRename)
                .controlSize(.small)
                .accessibilityIdentifier("prefs.devices.rename.\(device.id)")
            if canRemove {
                Button("Remove…", action: onRemove)
                    .controlSize(.small)
                    .accessibilityIdentifier("prefs.devices.remove.\(device.id)")
            }
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
