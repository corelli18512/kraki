/// DeviceUpdate — "is a newer Kraki available on this computer?"
///
/// Tentacles ≥ 0.36 report it in `device_greeting.update` (see
/// protocol/src/messages.ts `DeviceUpdateInfo`). Older tentacles don't, so for
/// them apps compare the reported version with the newest tentacle any other
/// computer on the account has seen published.

import Foundation

struct DeviceUpdateInfo: Codable, Equatable, Sendable {
    /// `mac-app` | `app-bundle` | `binary` | `npm` | `unknown`.
    var installedVia: String
    /// Version of what an update replaces (Mac app version for `mac-app`).
    var current: String
    /// Set only when newer than `current`.
    var latest: String?
    var latestTentacle: String?
    /// The computer accepts a remote update request.
    var remote: Bool?
    /// `disabled` | `not_writable` | `unsupported`.
    var remoteBlock: String?
    var checkedAt: String?

    init?(json: [String: Any]) {
        guard let via = json["installedVia"] as? String, let current = json["current"] as? String else { return nil }
        installedVia = via
        self.current = current
        latest = json["latest"] as? String
        latestTentacle = json["latestTentacle"] as? String
        remote = json["remote"] as? Bool
        remoteBlock = json["remoteBlock"] as? String
        checkedAt = json["checkedAt"] as? String
    }

    init(installedVia: String, current: String, latest: String? = nil, latestTentacle: String? = nil,
         remote: Bool? = nil, checkedAt: String? = nil) {
        self.installedVia = installedVia
        self.current = current
        self.latest = latest
        self.latestTentacle = latestTentacle
        self.remote = remote
        self.checkedAt = checkedAt
    }
}

/// A newer Kraki for one computer, and how to get it.
struct AvailableUpdate: Equatable, Sendable {
    let latest: String
    /// `mac-app` | `app-bundle` | `binary` | `npm` | `unknown` (`legacy` when
    /// inferred for a computer that predates update reporting).
    let installedVia: String
    let remote: Bool

    var isMacApp: Bool { installedVia == "mac-app" }

    /// One line telling the user how to update that computer themselves.
    var howTo: String {
        switch installedVia {
        case "mac-app": return "Open Kraki on that Mac and choose Kraki → Check for Updates…"
        case "legacy": return "Update Kraki on that computer: Check for Updates in Kraki for Mac, or run `kraki update`."
        default: return "Run `kraki update` on that computer."
        }
    }
}

/// A remote update in flight (or just finished), per computer. Not persisted.
struct DeviceUpdateProgress: Equatable, Sendable {
    enum Phase: String, Sendable {
        case requested, busy, waiting_idle, downloading, installing, updated, failed, rolled_back
    }
    var phase: Phase
    var requestId: String?
    var from: String?
    var to: String?
    var progress: Double?
    var runningSessions: Int?
    var error: String?
    var at: Date = Date()

    var isActive: Bool { [.requested, .waiting_idle, .downloading, .installing].contains(phase) }
}

enum KrakiVersion {
    /// Numeric core (`1.2.3`) of a version string; missing parts are 0.
    static func parts(_ v: String) -> [Int] {
        let core = v.split(separator: "-", maxSplits: 1).first.map(String.init) ?? v
        return core.split(separator: ".").map { Int($0) ?? 0 }
    }

    /// Pre-release identifiers (`beta.1` → ["beta", "1"]); empty for a release.
    static func prerelease(_ v: String) -> [String] {
        let pieces = v.split(separator: "-", maxSplits: 1)
        guard pieces.count == 2 else { return [] }
        return pieces[1].split(separator: "+").first.map { $0.split(separator: ".").map(String.init) } ?? []
    }

    /// Semantic-version order: `1.2.0-beta.1` < `1.2.0` < `1.2.1`.
    static func isNewer(_ a: String, than b: String) -> Bool {
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count, 3) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        let pa = prerelease(a), pb = prerelease(b)
        if pa.isEmpty || pb.isEmpty { return pa.isEmpty && !pb.isEmpty }
        for (l, r) in zip(pa, pb) where l != r {
            switch (Int(l), Int(r)) {
            case let (li?, ri?): return li > ri
            case (nil, _?): return true   // alphanumeric outranks numeric
            case (_?, nil): return false
            case (nil, nil): return l > r
            }
        }
        return pa.count > pb.count
    }
}

#if canImport(SwiftUI)
import SwiftUI

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
                Text("\(update.isMacApp ? "Kraki for Mac" : "Kraki") \(update.latest) is available")
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
        return n == 1 ? "1 session is running" : "\(n) sessions are running"
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
        "\(u.isMacApp ? "Kraki for Mac" : "Kraki") \(u.latest) is available"
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
                    Text(device.online ? "Kraki restarts on \(device.name); about a minute." : "Available when \(device.name) is online.")
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
        case "disabled": return "Updating from other devices is turned off on that computer. \(u.howTo)"
        case "not_writable": return "Kraki is installed where only an administrator can change it. Run `kraki update` on that computer."
        default: return u.howTo
        }
    }

    @ViewBuilder
    private func progressRow(_ p: DeviceUpdateProgress, now: Date) -> some View {
        let to = p.to.map { " \($0)" } ?? ""
        switch p.phase {
        case .requested:
            row(spinner: true, title: "Asking \(device.name) to update…") { EmptyView() }
        case .busy:
            row(icon: "exclamationmark.circle.fill", tint: .orange, title: busyTitle) {
                Button("Choose…") { askBusy = true }.controlSize(.small)
            }
        case .waiting_idle:
            row(spinner: true, title: "Will update when the running sessions finish") {
                Text("Kraki\(to) installs on \(device.name) as soon as nothing is running.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        case .downloading:
            row(spinner: true, title: "Downloading Kraki\(to)…") {
                if let f = p.progress { ProgressView(value: f).frame(maxWidth: 220) }
            }
        case .installing:
            if now.timeIntervalSince(p.at) > 180 {
                row(icon: "exclamationmark.triangle.fill", tint: .orange, title: "\(device.name) isn’t back online yet") {
                    Text("If it doesn’t return, check Kraki on that computer.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            } else {
                row(spinner: true, title: device.online ? "Installing Kraki\(to)…" : "Restarting Kraki on \(device.name)…") {
                    Text("It will be back online in a moment.").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
        case .updated:
            row(icon: "checkmark.circle.fill", tint: .green, title: "Updated to Kraki\(to)") { EmptyView() }
        case .rolled_back:
            row(icon: "arrow.uturn.backward.circle.fill", tint: .orange, title: "Update didn’t work, so nothing changed") {
                Text("The new version didn’t start on \(device.name), so it went back to\(p.from.map { " \($0)" } ?? " the previous version").")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        case .failed:
            row(icon: "xmark.circle.fill", tint: .red, title: "Couldn’t update") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(p.error ?? "Something went wrong. Nothing was changed.")
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
