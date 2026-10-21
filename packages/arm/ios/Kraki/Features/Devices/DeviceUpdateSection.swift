#if os(iOS)
import SwiftUI

/// Device detail › Update: a native grouped section. One status row (icon or
/// spinner, title, one line of detail) and, when there is something to do,
/// plain action rows below it — like Settings › Software Update.
struct DeviceUpdateSection: View {
    @Environment(AppState.self) private var appState
    let device: DeviceSummary
    @State private var askBusy = false

    private var store: DeviceStore { appState.deviceStore }

    /// Whether the section has anything to show (callers hide it otherwise).
    static func isShown(_ store: DeviceStore, _ id: String) -> Bool {
        store.updateProgress[id] != nil || store.availableUpdate(for: id) != nil
    }

    /// Re-evaluated every few seconds (install timeout) without wrapping the
    /// Section itself, which would collapse its rows into one cell.
    @State private var now = Date()
    private let tick = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    var body: some View {
        Section {
            content(now: now)
        } header: {
            Text("Update")
        } footer: {
            footer(now: now)
        }
        .onReceive(tick) { now = $0 }
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
    }

    private var busyTitle: String {
        let n = store.updateProgress[device.id]?.runningSessions ?? 0
        return String(localized: "\(n) sessions are running")
    }

    private func version(_ v: String?) -> String { v.map { "Kraki \($0)" } ?? "Kraki" }

    /// Installing for this long with no outcome means something went wrong.
    static let installTimeout: TimeInterval = 180

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let p = store.updateProgress[device.id] {
            progress(p, now: now)
        } else if let u = store.availableUpdate(for: device.id) {
            StatusRow(symbol: "arrow.down.circle.fill", tint: .krakiPrimary,
                      title: u.isMacApp ? String(localized: "Kraki for Mac \(u.latest) is available") : String(localized: "Kraki \(u.latest) is available"),
                      detail: u.remote ? nil : blockedText(u))
            if u.remote {
                ActionRow(title: String(localized: "Update Now"), identifier: "device.update.button") {
                    appState.commandSender?.updateDevice(device.id)
                }
                .disabled(!device.online)
            }
        }
    }

    @ViewBuilder
    private func footer(now: Date) -> some View {
        if store.updateProgress[device.id] == nil, let u = store.availableUpdate(for: device.id), u.remote {
            Text(device.online
                 ? "Kraki restarts on \(device.name). This takes about a minute; running sessions are asked about first."
                 : "Available when \(device.name) is online.")
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
    private func progress(_ p: DeviceUpdateProgress, now: Date) -> some View {
        let target = version(p.to)
        switch p.phase {
        case .requested:
            StatusRow(spinner: true, title: String(localized: "Asking \(device.name) to update…"))
        case .busy:
            StatusRow(symbol: "exclamationmark.circle.fill", tint: .orange, title: busyTitle,
                      detail: String(localized: "Updating restarts Kraki and stops them."))
            ActionRow(title: String(localized: "Choose…"), identifier: "device.update.choose") { askBusy = true }
        case .waiting_idle:
            StatusRow(spinner: true, title: String(localized: "Waiting for sessions to finish"),
                      detail: String(localized: "\(target) installs as soon as nothing is running on \(device.name)."))
        case .downloading:
            StatusRow(spinner: true, title: String(localized: "Downloading \(target)…"), progress: p.progress)
        case .installing where now.timeIntervalSince(p.at) > Self.installTimeout:
            if device.online {
                StatusRow(symbol: "exclamationmark.triangle.fill", tint: .orange,
                          title: String(localized: "The update didn’t finish"),
                          detail: p.from.map { String(localized: "\(device.name) is back online but still runs Kraki \($0).") }
                              ?? String(localized: "\(device.name) is back online, but \(target) wasn’t installed."))
                ActionRow(title: String(localized: "Try Again"), identifier: "device.update.retry") { appState.commandSender?.updateDevice(device.id) }
                ActionRow(title: String(localized: "Dismiss"), tint: .secondary, identifier: "device.update.dismiss") { store.setUpdateProgress(device.id, nil) }
            } else {
                StatusRow(symbol: "exclamationmark.triangle.fill", tint: .orange,
                          title: String(localized: "\(device.name) isn’t back online yet"),
                          detail: String(localized: "If it doesn’t return, open Kraki on that computer."))
            }
        case .installing:
            StatusRow(spinner: true, title: String(localized: "Installing \(target)…"),
                      detail: device.online ? nil : String(localized: "Kraki is restarting on \(device.name)."))
        case .updated:
            StatusRow(symbol: "checkmark.circle.fill", tint: .green, title: String(localized: "Updated to \(target)"),
                      detail: String(localized: "\(device.name) is up to date."))
        case .rolled_back:
            StatusRow(symbol: "arrow.uturn.backward.circle.fill", tint: .orange,
                      title: String(localized: "Update didn’t work"),
                      detail: String(localized: "\(target) didn’t start, so \(device.name) went back to \(version(p.from)). Nothing changed."))
            ActionRow(title: String(localized: "Dismiss"), tint: .secondary, identifier: "device.update.dismiss") { store.setUpdateProgress(device.id, nil) }
        case .failed:
            StatusRow(symbol: "xmark.circle.fill", tint: .red, title: String(localized: "Couldn’t update"),
                      detail: p.error ?? String(localized: "Something went wrong. Nothing was changed."))
            if store.availableUpdate(for: device.id)?.remote == true, device.online {
                ActionRow(title: String(localized: "Try Again"), identifier: "device.update.retry") { appState.commandSender?.updateDevice(device.id) }
            }
            ActionRow(title: String(localized: "Dismiss"), tint: .secondary, identifier: "device.update.dismiss") { store.setUpdateProgress(device.id, nil) }
        }
    }
}

/// Leading icon (or spinner) centred on the text block; system text styles.
private struct StatusRow: View {
    var symbol: String = ""
    var tint: Color = .primary
    var spinner = false
    let title: String
    var detail: String?
    var progress: Double?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                if spinner {
                    ProgressView()
                } else {
                    Image(systemName: symbol)
                        .font(.title2)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, tint)
                }
            }
            .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body)
                if let detail {
                    Text(LocalizedStringKey(detail))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let progress {
                    ProgressView(value: progress).padding(.top, 4)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("device.update")
    }
}

/// A plain tappable row, as in Settings (blue text, full width).
private struct ActionRow: View {
    let title: String
    var tint: Color = .krakiPrimary
    /// Stable, language-independent (never derived from the title).
    let identifier: String
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Text(title)
                .foregroundStyle(isEnabled ? tint : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .accessibilityIdentifier(identifier)
    }
}
#endif
