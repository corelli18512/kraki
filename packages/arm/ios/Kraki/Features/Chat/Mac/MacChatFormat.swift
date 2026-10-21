#if os(macOS)
import Foundation

/// Session-info number formats for the Mac chat inspector. Same output as
/// Shared/Helpers.swift (iOS-only); keep them in sync. Token counts and USD
/// costs are intentionally not locale-formatted; durations use catalog keys.
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
        if cost < 0.01 {
            return String(format: "$%.4f", cost)
        }
        return String(format: "$%.3f", cost)
    }

    static func duration(_ milliseconds: Double) -> String {
        guard milliseconds.isFinite, milliseconds >= 0 else { return "—" }
        let totalSeconds = min(milliseconds / 1_000, 1e12)
        if totalSeconds < 60 {
            return String(format: String(localized: "%.1fs"), totalSeconds)
        }
        let minutes = Int(totalSeconds) / 60
        let seconds = Int(totalSeconds) % 60
        return String(localized: "\(minutes)m \(seconds)s")
    }
}
#endif
