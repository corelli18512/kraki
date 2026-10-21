import Foundation
import SwiftUI

#if canImport(SwiftUI)
/// Small mark next to a computer's name: a newer Kraki is available there.
struct UpdateAvailableDot: View {
    var body: some View {
        Circle()
            .fill(Color.krakiPrimary)
            .frame(width: 6, height: 6)
            .accessibilityLabel("Update available")
            .help("A newer Kraki is available on this computer")
    }
}

/// "Kraki 0.36.0 is available" + how to get it; used in device details.
struct AvailableUpdateNotice: View {
    let update: AvailableUpdate
    /// Shown instead of the how-to when this is the Mac the app runs on.
    var checkForUpdates: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "arrow.down.circle.fill")
                .foregroundStyle(Color.krakiPrimary)
            VStack(alignment: .leading, spacing: 3) {
                Text("\(update.isMacApp ? String(localized: "Kraki for Mac") : "Kraki") \(update.latest) is available")
                    .font(.system(size: 13, weight: .medium))
                if let checkForUpdates {
                    Button("Check for Updates…", action: checkForUpdates)
                        .controlSize(.small)
                        .padding(.top, 2)
                } else {
                    Text(LocalizedStringKey(update.howTo))
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityIdentifier("device.updateAvailable")
    }
}
#endif

#if canImport(SwiftUI)
/// Everything about updating one computer: "Kraki x is available", the
/// Update button (remote update), progress, and the outcome.
struct DeviceUpdateControl: View {
    @Environment(AppState.self) private var appState
    let device: DeviceSummary
    /// The Mac this app runs on: update it with Sparkle, here.
    var isThisMac = false
    @State private var askBusy = false

    private var store: DeviceStore { appState.deviceStore }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            content(now: context.date)
        }
        .confirmationDialog(busyTitle, isPresented: $askBusy, titleVisibility: .visible) {
            Button("Update Now") { appState.commandSender?.updateDevice(device.id, when: "now") }
            Button("Update When They Finish") { appState.commandSender?.updateDevice(device.id, when: "idle") }
            Button("Cancel", role: .cancel) { store.setUpdateProgress(device.id, nil) }
        } message: {
            Text("Updating restarts Kraki on \(device.name) and stops these sessions.")
        }
        .onChange(of: store.updateProgress[device.id]?.phase) { _, phase in
            if phase == .busy { askBusy = true }
        }
        .accessibilityIdentifier("device.update")
    }

    private var busyTitle: String {
        let n = store.updateProgress[device.id]?.runningSessions ?? 0
        return String(localized: "\(n) sessions are running")
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let p = store.updateProgress[device.id], visible(p, now: now) {
            progressRow(p, now: now)
        } else if let u = store.availableUpdate(for: device.id) {
            availableRow(u)
        }
    }

    private func visible(_ p: DeviceUpdateProgress, now: Date) -> Bool {
        p.isActive || p.phase == .busy || now.timeIntervalSince(p.at) < 600
    }

    private func label(_ u: AvailableUpdate) -> String {
        String(localized: "\(u.isMacApp ? String(localized: "Kraki for Mac") : "Kraki") \(u.latest) is available")
    }

    @ViewBuilder
    private func availableRow(_ u: AvailableUpdate) -> some View {
        row(icon: "arrow.down.circle.fill", tint: .krakiPrimary, title: label(u)) {
            if isThisMac && u.isMacApp {
                Button("Check for Updates…") {
                    #if os(macOS)
                    NotificationCenter.default.post(name: .macCheckForUpdates, object: nil)
                    #endif
                }
                .controlSize(.small)
            } else if u.remote {
                HStack(spacing: 10) {
                    Button("Update") { appState.commandSender?.updateDevice(device.id) }
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                        .tint(.krakiPrimary)
                        .disabled(!device.online)
                        .accessibilityIdentifier("device.update.button")
                    Text(device.online ? String(localized: "Kraki restarts on \(device.name); about a minute.") : String(localized: "Available when \(device.name) is online."))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            } else {
                Text(LocalizedStringKey(blockedText(u)))
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func blockedText(_ u: AvailableUpdate) -> String {
        switch store.deviceUpdates[device.id]?.remoteBlock {
        case "disabled": return String(localized: "Updating from other devices is turned off on that computer. \(u.howTo)")
        case "not_writable": return String(localized: "Kraki is installed where only an administrator can change it. Run `kraki update` on that computer.")
        default: return u.howTo
        }
    }

    @ViewBuilder
    private func progressRow(_ p: DeviceUpdateProgress, now: Date) -> some View {
        let to = p.to.map { " \($0)" } ?? ""
        switch p.phase {
        case .requested:
            row(spinner: true, title: String(localized: "Asking \(device.name) to update…")) { EmptyView() }
        case .busy:
            row(icon: "exclamationmark.circle.fill", tint: .orange, title: busyTitle) {
                Button("Choose…") { askBusy = true }.controlSize(.small)
            }
        case .waiting_idle:
            row(spinner: true, title: String(localized: "Will update when the running sessions finish")) {
                Text("Kraki\(to) installs on \(device.name) as soon as nothing is running.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        case .downloading:
            row(spinner: true, title: String(localized: "Downloading Kraki\(to)…")) {
                if let f = p.progress { ProgressView(value: f).frame(maxWidth: 220) }
            }
        case .installing:
            if now.timeIntervalSince(p.at) > 180 {
                row(icon: "exclamationmark.triangle.fill", tint: .orange, title: String(localized: "\(device.name) isn’t back online yet")) {
                    Text("If it doesn’t return, check Kraki on that computer.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            } else {
                row(spinner: true, title: device.online ? String(localized: "Installing Kraki\(to)…") : String(localized: "Restarting Kraki on \(device.name)…")) {
                    Text("It will be back online in a moment.").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
        case .updated:
            row(icon: "checkmark.circle.fill", tint: .green, title: String(localized: "Updated to Kraki\(to)")) { EmptyView() }
        case .rolled_back:
            row(icon: "arrow.uturn.backward.circle.fill", tint: .orange, title: String(localized: "Update didn’t work, so nothing changed")) {
                Text(p.from.map { String(localized: "The new version didn’t start on \(device.name), so it went back to \($0).") }
                         ?? String(localized: "The new version didn’t start on \(device.name), so it went back to the previous version."))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        case .failed:
            row(icon: "xmark.circle.fill", tint: .red, title: String(localized: "Couldn’t update")) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(p.error ?? String(localized: "Something went wrong. Nothing was changed."))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Button("Dismiss") { store.setUpdateProgress(device.id, nil) }.controlSize(.small)
                }
            }
        }
    }

    private func row<Extra: View>(icon: String = "", tint: Color = .primary, spinner: Bool = false, title: String,
                                  @ViewBuilder extra: () -> Extra) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if spinner {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: icon).foregroundStyle(tint)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 13, weight: .medium))
                extra()
            }
        }
    }
}
#endif
