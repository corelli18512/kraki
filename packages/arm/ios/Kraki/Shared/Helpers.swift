#if os(iOS)
/// Helpers — Utility functions for formatting dates, numbers, and text.

import Foundation

// MARK: - Relative Timestamps

/// Format a date as a relative time string: "2m ago", "1h ago", "3d ago", etc.
func relativeTimestamp(_ date: Date) -> String {
    let seconds = Int(-date.timeIntervalSinceNow)
    if seconds < 5 { return "just now" }
    if seconds < 60 { return "\(seconds)s ago" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h ago" }
    let days = hours / 24
    if days < 30 { return "\(days)d ago" }
    let months = days / 30
    if months < 12 { return "\(months)mo ago" }
    let years = months / 12
    return "\(years)y ago"
}

// MARK: - Token Counts

/// Format a token count: 1234 → "1.2K", 45300 → "45.3K", etc.
func formatTokenCount(_ count: Int) -> String {
    if count < 1_000 { return "\(count)" }
    if count < 1_000_000 {
        let k = Double(count) / 1_000
        return k < 10 ? String(format: "%.1fK", k) : String(format: "%.0fK", k)
    }
    let m = Double(count) / 1_000_000
    return m < 10 ? String(format: "%.1fM", m) : String(format: "%.0fM", m)
}

// MARK: - Cost

/// Format a dollar cost: 0.042 → "$0.042".
func formatCost(_ cost: Double) -> String {
    if cost < 0.01 {
        return String(format: "$%.4f", cost)
    }
    return String(format: "$%.3f", cost)
}

// MARK: - Duration

/// Format milliseconds into a human-readable duration: "2.3s", "1m 23s".
func formatDuration(_ ms: Double) -> String {
    let totalSeconds = ms / 1_000
    if totalSeconds < 60 {
        return String(format: "%.1fs", totalSeconds)
    }
    let minutes = Int(totalSeconds) / 60
    let seconds = Int(totalSeconds) % 60
    return "\(minutes)m \(seconds)s"
}

// MARK: - Truncation

/// Truncate a string to a maximum length, appending "…" if truncated.
func truncate(_ text: String, maxLength: Int) -> String {
    guard text.count > maxLength else { return text }
    return String(text.prefix(maxLength)) + "…"
}

// MARK: - Args Summary

/// Extract a human-readable summary from tool args, mirroring getArgsSummary in PermissionInput.tsx.
func getArgsSummary(toolName: String?, args: [String: AnyCodable]?) -> String? {
    guard let toolName, let args else { return nil }

    switch toolName {
    case "shell", "bash":
        return args["command"]?.stringValue
    case "write_file", "edit_file", "create_file", "read_file", "view":
        return args["path"]?.stringValue
    case "fetch_url":
        return args["url"]?.stringValue
    default:
        for (_, v) in args {
            if let s = v.stringValue, !s.isEmpty, s.count < 200 {
                return s
            }
        }
        return nil
    }
}

#endif
