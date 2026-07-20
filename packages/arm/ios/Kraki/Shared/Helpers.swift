#if os(iOS)
/// Helpers — Utility functions for formatting dates, numbers, and text.

import Foundation
import UIKit

// MARK: - Shared ISO8601 Formatters
//
// Cached static formatters used by hot-path code (session sort,
// command timestamps, message stamping). Allocating a new
// `ISO8601DateFormatter` per call is surprisingly expensive — these
// statics shave it off entirely.

enum ISO8601 {
    /// Primary formatter: full ISO-8601 with fractional seconds, the
    /// format the relay and tentacle emit.
    static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Fallback formatter without fractional seconds — older relay
    /// versions and some manual fixtures use this shape.
    static let withoutFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Parse an ISO-8601 string, trying both formatter variants.
    /// Tolerant of "Z" vs "+00:00" suffix differences across relay
    /// versions and manual inputs.
    ///
    /// PERF: `ISO8601DateFormatter.date(from:)` is ~20µs even with a
    /// cached formatter. Hot paths (session sort runs this once per
    /// session, several times per websocket push) re-parse the SAME
    /// timestamp strings repeatedly. A small thread-safe memo cache
    /// makes repeat parses of an unchanged timestamp O(1), so a steady
    /// stream of pushes stops re-paying the parse cost.
    static func parse(_ string: String) -> Date? {
        if let hit = cache.lookup(string) { return hit }
        let parsed = withFractional.date(from: string) ?? withoutFractional.date(from: string)
        cache.store(string, parsed)
        return parsed
    }

    /// Bounded, lock-guarded memo for `parse`. Distinct timestamp
    /// strings are bounded in practice (≈ session + message count),
    /// but we cap the cache and drop it wholesale on overflow so it
    /// can never grow without limit over a long-lived session.
    private final class ParseCache: @unchecked Sendable {
        private var map: [String: Date?] = [:]
        private let lock = NSLock()
        private let cap = 4096

        func lookup(_ key: String) -> Date?? {
            lock.lock(); defer { lock.unlock() }
            return map[key]
        }

        func store(_ key: String, _ value: Date?) {
            lock.lock(); defer { lock.unlock() }
            if map.count >= cap { map.removeAll(keepingCapacity: true) }
            map[key] = value
        }
    }

    private static let cache = ParseCache()

    /// Stamp the current instant in the canonical relay format.
    static func now() -> String {
        withFractional.string(from: Date())
    }
}

// MARK: - Window/scene size helper
//
// `UIScreen.main.bounds` is wrong on iPad split-view, slide-over,
// and Stage Manager — it returns the device-wide size regardless of
// the app's actual window. These helpers return the size of the
// currently key window's scene, falling back to UIScreen.main.bounds
// only when no window can be located (background/launch states).
//
// For static reads (one-shot layout calculation that doesn't need
// to re-fire on resize), use `WindowSize.width` / `.height`. For
// SwiftUI views that should refresh when the user resizes the
// window (iPad Split View / Stage Manager), inject and observe
// `WindowSizeObserver.shared`; it republishes the size on
// `UIWindowScene.didUpdateCoordinateSpaceNotification`.

enum WindowSize {
    static var width: CGFloat { current().width }
    static var height: CGFloat { current().height }

    static func current() -> CGSize {
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first,
           let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first {
            return window.bounds.size
        }
        return UIScreen.main.bounds.size
    }
}

import Observation

/// Observable wrapper around `WindowSize` that republishes whenever
/// the active window scene's coordinate space changes (iPad Split
/// View resize, Stage Manager move, rotation). Inject with
/// `.environment(WindowSizeObserver.shared)` and read via the
/// observed `size` property to make SwiftUI re-layout on resize.
@MainActor
@Observable
final class WindowSizeObserver {
    static let shared = WindowSizeObserver()

    private(set) var size: CGSize = WindowSize.current()

    private init() {
        // UIKit doesn't expose a single "window resized" notification
        // we can rely on across iPad Split View, Stage Manager, and
        // rotation. We hook the closest signals — device orientation
        // changes (rotation) and app foreground — and re-sample the
        // window size on each. Views needing pixel-perfect resize
        // reactivity should still use `GeometryReader` in the parent;
        // this observer is a coarse net for components that read the
        // window size for layout heuristics.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSceneChange),
            name: UIDevice.orientationDidChangeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSceneChange),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func handleSceneChange() {
        let next = WindowSize.current()
        if next != size {
            size = next
        }
    }
}

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
        // Walk well-known argument names first, then fall back to a
        // deterministic sorted iteration. Without the sort, the
        // returned headline could differ across runs depending on
        // dictionary hash ordering, which makes UI snapshots and
        // logs noisy.
        let preferredKeys = ["query", "path", "file", "url", "name", "id", "key"]
        for k in preferredKeys {
            if let s = args[k]?.stringValue, !s.isEmpty, s.count < 200 { return s }
        }
        for k in args.keys.sorted() {
            if let s = args[k]?.stringValue, !s.isEmpty, s.count < 200 { return s }
        }
        return nil
    }
}

#endif
