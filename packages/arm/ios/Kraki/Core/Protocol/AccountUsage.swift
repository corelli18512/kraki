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
    /// Agents on the reporting machine signed in with this account.
    var agents: [String]?
    /// Derived from the reporting worker's configured polling cadence.
    var staleAfterSeconds: Double?
    /// Provider retry deadline, distinct from a quota window's reset date.
    var retryAt: String?

    var id: String { accountKey }

    /// The windows drawn as rings: 5-hour then weekly, side by side. Falls
    /// back to whatever the provider reports when neither is present.
    var ringWindows: [AccountUsageWindow] {
        let main = [windows.first { $0.kind == "five_hour" }, windows.first { $0.kind == "weekly" }].compactMap { $0 }
        return main.isEmpty ? Array(windows.prefix(2)) : main
    }

    var fetchedDate: Date? {
        // Older workers timestamp even a failed first read. With no quota
        // windows, that does not establish a last successful quota reading.
        guard error == nil || !windows.isEmpty else { return nil }
        return ISO8601.parse(fetchedAt)
    }

    /// Two worst-case polls plus grace. Older workers use 15m ±10%, not 5m.
    var freshnessLifetime: TimeInterval {
        guard let seconds = staleAfterSeconds, seconds.isFinite, seconds > 0 else { return 2040 }
        return min(15_900, max(60, seconds)) // configured polling is at most 120m
    }

    func isStale(now: Date = Date()) -> Bool {
        error != nil || (fetchedDate.map { now.timeIntervalSince($0) > freshnessLifetime } ?? true)
    }

    var retryDate: Date? { retryAt.flatMap(ISO8601.parse) }

    func readStatus(now: Date = Date()) -> String? {
        switch error {
        case "auth": return "Sign-in needed"
        case "rate_limited":
            if let retry = retryDate, retry > now {
                return "Rate limited · retry in \(max(1, Int(ceil(retry.timeIntervalSince(now) / 60))))m"
            }
            return "Rate limited · try refreshing"
        case .some: return "Couldn't refresh"
        case .none: return isStale(now: now) ? "Update overdue" : nil
        }
    }

    func lastUpdatedText(now: Date = Date()) -> String {
        guard let date = fetchedDate else { return "Not updated yet" }
        let age = max(0, now.timeIntervalSince(date))
        if age < 60 { return "Updated just now" }
        if age < 3600 { return "Updated \(Int(age / 60))m ago" }
        if age < 86400 { return "Updated \(Int(age / 3600))h ago" }
        return "Updated \(Int(age / 86400))d ago"
    }

    var providerTitle: String { provider == "codex" ? "GPT" : "Claude" }

    /// Masked local part only (`co•••ai`) for tight spaces; the full label is in the tooltip.
    var shortLabel: String {
        guard let label, let at = label.firstIndex(of: "@") else { return label ?? providerTitle }
        return String(label[..<at])
    }

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
    var requestId: String?
    var refreshError: String?
}

/// Latest `device_usage` from one tentacle.
struct DeviceUsageSnapshot: Equatable, Sendable {
    var accounts: [AccountUsage]
    var receivedAt: Date
}

/// Ephemeral per-device request state. Never persisted or replayed on reconnect.
struct AccountUsageRefreshState: Equatable {
    let requestId: String
    let startedAt: Date
    var finished = false
    var error: String?
}

/// One subscription account across every device that reports it. Quota is
/// per account, so the same account signed in on three machines is one card.
struct MergedAccountUsage: Identifiable, Equatable, Sendable {
    /// The freshest reading among the reporting devices.
    var account: AccountUsage
    /// Devices this account is signed in on; online ones first.
    var devices: [DeviceSummary]
    var id: String { account.accountKey }
    /// True when no online device reports it any more.
    var allOffline: Bool { !devices.contains(where: \.online) }
}

extension AccountUsage {
    /// Pi model ids carry the provider: `anthropic/…`, `openai-codex/…`.
    static func provider(forModel model: String?) -> String? {
        guard let model = model?.lowercased() else { return nil }
        if model.hasPrefix("anthropic/") || model.contains("claude") { return "claude" }
        if model.hasPrefix("openai") || model.contains("gpt") || model.contains("codex") { return "codex" }
        return nil
    }
}
