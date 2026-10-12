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
        case "windows-app": return "Install the latest Kraki for Windows on that PC. Kraki updates with the app."
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
