import Foundation

/// Session-usage numbers (iOS Session info sheet and Mac chat inspector).
/// Cost keeps its fixed precision ($0.042, 4 places under a cent) and token
/// counts keep compact K/M notation, but grouping, the decimal separator and
/// the currency symbol's placement follow the user's region.
enum UsageNumberFormat {
    static func cost(_ cost: Double, locale: Locale = .autoupdatingCurrent) -> String {
        let fractionDigits = cost < 0.01 ? 4 : 3
        return cost.formatted(
            .currency(code: "USD")
                .precision(.fractionLength(fractionDigits))
                .locale(locale)
        )
    }

    static func duration(_ milliseconds: Double, locale: Locale = .autoupdatingCurrent) -> String {
        // Peer-reported: Int(_:) traps on NaN, infinity or values beyond Int.
        guard milliseconds.isFinite, milliseconds >= 0 else { return "—" }
        let totalSeconds = min(milliseconds / 1_000, 1e12)
        if totalSeconds < 60 {
            return String(format: String(localized: "%.1fs"), locale: locale, totalSeconds)
        }
        let minutes = Int(totalSeconds) / 60
        let seconds = Int(totalSeconds) % 60
        return String(localized: "\(minutes)m \(seconds)s")
    }
}
