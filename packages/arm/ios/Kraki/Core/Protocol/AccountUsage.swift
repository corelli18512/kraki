/// AccountUsage — read-only subscription quota a tentacle reports for the
/// Claude / Codex accounts signed in on its machine (`device_usage`).
///
/// Mirrors `AccountUsage` in packages/protocol/src/messages.ts. Values are
/// never invented: a window the provider doesn't report is simply absent.

import Foundation

struct AccountUsageWindow: Codable, Hashable, Sendable, Identifiable {
    let id: String
    /// `five_hour` | `weekly` | `other`
    let kind: String
    var title: String?
    let remainingPercent: Double
    var resetsAt: String?
    var durationSeconds: Double?

    var resetDate: Date? { resetsAt.flatMap(ISO8601.parse) }
}

struct AccountUsage: Codable, Hashable, Sendable, Identifiable {
    let accountKey: String
    /// `claude` | `codex`
    let provider: String
    var label: String?
    var plan: String?
    let windows: [AccountUsageWindow]
    let fetchedAt: String
    var error: String?

    var id: String { accountKey }

    /// The windows drawn as rings: 5-hour then weekly, side by side. Falls
    /// back to whatever the provider reports when neither is present.
    var ringWindows: [AccountUsageWindow] {
        let main = [windows.first { $0.kind == "five_hour" }, windows.first { $0.kind == "weekly" }].compactMap { $0 }
        return main.isEmpty ? Array(windows.prefix(2)) : main
    }

    var fetchedDate: Date? { ISO8601.parse(fetchedAt) }

    /// Older than two polls, or the last attempt failed.
    func isStale(now: Date = Date()) -> Bool {
        error != nil || (fetchedDate.map { now.timeIntervalSince($0) > 660 } ?? true)
    }

    var providerTitle: String { provider == "codex" ? "GPT" : "Claude" }

    var planTitle: String? {
        switch plan {
        case "default_claude_max_20x": return "Max 20×"
        case "default_claude_max_5x": return "Max 5×"
        case "default_claude_pro", "pro": return "Pro"
        case "max": return "Max"
        case "prolite": return "Pro Lite"
        case "plus": return "Plus"
        case "team": return "Team"
        default: return plan
        }
    }
}

struct DeviceUsagePayload: Codable, Sendable {
    let accounts: [AccountUsage]
    var updatedAt: String?
}

/// Latest `device_usage` from one tentacle.
struct DeviceUsageSnapshot: Equatable, Sendable {
    var accounts: [AccountUsage]
    var receivedAt: Date
}
