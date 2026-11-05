#if os(macOS)
import Foundation

/// Session-info number formats for the Mac chat inspector. Same output as
/// Shared/Helpers.swift (iOS-only); keep them in sync. Token counts keep the
/// compact K/M notation; cost and duration come from `UsageNumberFormat`.
enum MacChatFormat {
    static func tokenCount(_ count: Int) -> String {
        if count < 1_000 { return "\(count)" }
        if count < 1_000_000 {
            let k = Double(count) / 1_000
            return k < 10 ? String(format: "%.1fK", k) : String(format: "%.0fK", k)
        }
        let m = Double(count) / 1_000_000
        return m < 10 ? String(format: "%.1fM", m) : String(format: "%.0fM", m)
    }

    static func cost(_ cost: Double) -> String {
        UsageNumberFormat.cost(cost)
    }

    static func duration(_ milliseconds: Double) -> String {
        UsageNumberFormat.duration(milliseconds)
    }
}
#endif
