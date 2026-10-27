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

    private var busyTitle: String { Self.busyTitle(store.updateProgress[device.id]) }

    /// Installing for this long with no outcome means something went wrong.
    static let installTimeout: TimeInterval = 180

    /// An update with no new status for `installTimeout` is not expected to
    /// finish by itself (e.g. the computer never came back).
    static func isStalled(_ p: DeviceUpdateProgress, now: Date) -> Bool {
        p.isActive && now.timeIntervalSince(p.at) > installTimeout
    }

    /// Offline in the middle of an update is a restart, not a dead computer,
    /// so Remove Device waits, but only until the update stalls.
    static func blocksRemoval(_ p: DeviceUpdateProgress?, now: Date) -> Bool {
        guard let p else { return false }
        return p.isActive && !isStalled(p, now: now)
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if let p = Self.presentation(device: device, store: store, now: now) {
            switch p.icon {
            case .spinner:
                StatusRow(spinner: true, title: p.title, detail: p.detail, progress: p.progress)
            case let .symbol(symbol, tint):
                StatusRow(symbol: symbol, tint: tint, title: p.title, detail: p.detail, progress: p.progress)
            }
            ForEach(p.actions, id: \.self) { actionRow($0) }
        }
    }

    @ViewBuilder
    private func actionRow(_ action: Presentation.Action) -> some View {
        switch action {
        case let .updateNow(enabled):
            ActionRow(title: String(localized: "Update Now"), identifier: "device.update.button") {
                appState.commandSender?.updateDevice(device.id)
            }
            .disabled(!enabled)
        case .choose:
            ActionRow(title: String(localized: "Choose…"), identifier: "device.update.choose") { askBusy = true }
        case .retry:
            ActionRow(title: String(localized: "Try Again"), identifier: "device.update.retry") { appState.commandSender?.updateDevice(device.id) }
        case .dismiss:
            ActionRow(title: String(localized: "Dismiss"), tint: .secondary, identifier: "device.update.dismiss") { store.setUpdateProgress(device.id, nil) }
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

    /// What the section shows for one computer: one status row plus its
    /// action rows. Decided outside the view so every state is testable.
    struct Presentation: Equatable {
        enum Icon: Equatable { case spinner, symbol(String, Color) }
        enum Action: Hashable { case updateNow(enabled: Bool), choose, retry, dismiss }
        var icon: Icon
        var title: String
        var detail: String?
        var progress: Double?
        var actions: [Action] = []
    }

    static func presentation(device: DeviceSummary, store: DeviceStore, now: Date) -> Presentation? {
        if let p = store.updateProgress[device.id] {
            return progress(p, device: device, store: store, now: now)
        }
        guard let u = store.availableUpdate(for: device.id) else { return nil }
        return Presentation(icon: .symbol("arrow.down.circle.fill", .krakiPrimary),
                            title: u.isMacApp ? String(localized: "Kraki for Mac \(u.latest) is available") : String(localized: "Kraki \(u.latest) is available"),
                            detail: u.remote ? nil : blockedText(u, store.deviceUpdates[device.id]?.remoteBlock),
                            actions: u.remote ? [.updateNow(enabled: device.online)] : [])
    }

    private static func version(_ v: String?) -> String { v.map { "Kraki \($0)" } ?? "Kraki" }

    private static func busyTitle(_ p: DeviceUpdateProgress?) -> String {
        let n = p?.runningSessions ?? 0
        return String(localized: "\(n) sessions are running")
    }

    private static func blockedText(_ u: AvailableUpdate, _ remoteBlock: String?) -> String {
        switch remoteBlock {
        case "disabled": return String(localized: "Updating from other devices is turned off on that computer. \(u.howTo)")
        case "not_writable": return String(localized: "Kraki is installed where only an administrator can change it. Run `kraki update` on that computer.")
        default: return u.howTo
        }
    }

    // swiftlint:disable:next function_body_length
    private static func progress(_ p: DeviceUpdateProgress, device: DeviceSummary, store: DeviceStore,
                                 now: Date) -> Presentation {
        let target = version(p.to)
        let warning = Presentation.Icon.symbol("exclamationmark.triangle.fill", .orange)
        if !device.online, isStalled(p, now: now) {
            return Presentation(icon: warning, title: String(localized: "\(device.name) isn’t back online yet"),
                                detail: String(localized: "If it doesn’t return, open Kraki on that computer."),
                                actions: [.dismiss])
        }
        switch p.phase {
        case .requested:
            return Presentation(icon: .spinner, title: String(localized: "Asking \(device.name) to update…"))
        case .busy:
            return Presentation(icon: .symbol("exclamationmark.circle.fill", .orange), title: busyTitle(p),
                                detail: String(localized: "Updating restarts Kraki and stops them."), actions: [.choose])
        case .waiting_idle:
            return Presentation(icon: .spinner, title: String(localized: "Waiting for sessions to finish"),
                                detail: String(localized: "\(target) installs as soon as nothing is running on \(device.name)."))
        case .downloading:
            return Presentation(icon: .spinner, title: String(localized: "Downloading \(target)…"), progress: p.progress)
        case .installing where isStalled(p, now: now):
            return Presentation(icon: warning, title: String(localized: "The update didn’t finish"),
                                detail: p.from.map { String(localized: "\(device.name) is back online but still runs Kraki \($0).") }
                                    ?? String(localized: "\(device.name) is back online, but \(target) wasn’t installed."),
                                actions: [.retry, .dismiss])
        case .installing:
            return Presentation(icon: .spinner, title: String(localized: "Installing \(target)…"),
                                detail: device.online ? nil : String(localized: "Kraki is restarting on \(device.name)."))
        case .updated:
            return Presentation(icon: .symbol("checkmark.circle.fill", .green), title: String(localized: "Updated to \(target)"),
                                detail: String(localized: "\(device.name) is up to date."))
        case .rolled_back:
            return Presentation(icon: .symbol("arrow.uturn.backward.circle.fill", .orange),
                                title: String(localized: "Update didn’t work"),
                                detail: String(localized: "\(target) didn’t start, so \(device.name) went back to \(version(p.from)). Nothing changed."),
                                actions: [.dismiss])
        case .failed:
            let retry = store.availableUpdate(for: device.id)?.remote == true && device.online
            return Presentation(icon: .symbol("xmark.circle.fill", .red), title: String(localized: "Couldn’t update"),
                                detail: p.error ?? String(localized: "Something went wrong. Nothing was changed."),
                                actions: retry ? [.retry, .dismiss] : [.dismiss])
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
