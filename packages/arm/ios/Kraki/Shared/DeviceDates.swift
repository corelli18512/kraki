import Foundation

/// Dates the relay sends for devices come in two shapes: ISO 8601 (with or
/// without fractional seconds) and SQLite's "yyyy-MM-dd HH:mm:ss" (UTC).
enum DeviceDates {
    static func parse(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        if let d = ISO8601.parse(raw) { return d }
        return sqlFormatter.date(from: raw)
    }

    private static let sqlFormatter: DateFormatter = {
        let sql = DateFormatter()
        sql.locale = Locale(identifier: "en_US_POSIX")
        sql.timeZone = TimeZone(identifier: "UTC")
        sql.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return sql
    }()

    /// "today", "yesterday", "Sep 28" style, for "Last online …".
    static func relative(_ raw: String?, now: Date = Date()) -> String? {
        guard let date = parse(raw) else { return nil }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "today" }
        if cal.isDateInYesterday(date) { return "yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
