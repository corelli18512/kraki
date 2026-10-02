import Foundation

/// Dates the relay sends for devices come in two shapes: ISO 8601 (with or
/// without fractional seconds) and SQLite's "yyyy-MM-dd HH:mm:ss" (UTC).
enum DeviceDates {
    static func parse(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: raw) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: raw) { return d }
        let sql = DateFormatter()
        sql.locale = Locale(identifier: "en_US_POSIX")
        sql.timeZone = TimeZone(identifier: "UTC")
        sql.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return sql.date(from: raw)
    }

    /// "today", "yesterday", "Sep 28" style, for "Last online …".
    static func relative(_ raw: String?, now: Date = Date()) -> String? {
        guard let date = parse(raw) else { return nil }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "today" }
        if cal.isDateInYesterday(date) { return "yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
