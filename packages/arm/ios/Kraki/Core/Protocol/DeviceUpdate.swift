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
    var checkedAt: String?

    init?(json: [String: Any]) {
        guard let via = json["installedVia"] as? String, let current = json["current"] as? String else { return nil }
        installedVia = via
        self.current = current
        latest = json["latest"] as? String
        latestTentacle = json["latestTentacle"] as? String
        remote = json["remote"] as? Bool
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

enum KrakiVersion {
    /// Numeric major.minor.patch; a pre-release suffix (`-poc`) is ignored.
    static func parts(_ v: String) -> [Int] {
        let core = v.split(separator: "-", maxSplits: 1).first.map(String.init) ?? v
        return core.split(separator: ".").map { Int($0) ?? 0 }
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count, 3) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
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
