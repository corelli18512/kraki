/// KrakiPlatform — Cross-platform typealiases for UIKit / AppKit.
///
/// We share SwiftUI views between iOS and macOS targets. The view bodies
/// are platform-agnostic, but a handful of helpers (Color initializers,
/// haptics, pasteboard) reach down to the platform-native primitive.
/// Centralizing those here keeps the rest of `Shared/` free of `#if`
/// pollution.

import SwiftUI

#if os(iOS)
import UIKit

public typealias PlatformColor = UIColor
public typealias PlatformImage = UIImage

// Note: `Color.init(light: UIColor, dark: UIColor)` is defined in
// `Theme.swift` for iOS — do not redefine here.

#elseif os(macOS)
import AppKit

public typealias PlatformColor = NSColor
public typealias PlatformImage = NSImage

extension Color {
    init(light: PlatformColor, dark: PlatformColor) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil ? dark : light
        })
    }
}

#endif

// MARK: - Pasteboard

enum KrakiPasteboard {
    static func setString(_ string: String) {
        #if os(iOS)
        UIPasteboard.general.string = string
        #elseif os(macOS)
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(string, forType: .string)
        #endif
    }
}

// MARK: - Device Name

enum KrakiDevice {
    /// Human-readable device name (e.g. "MacBook Pro").
    /// On iOS this is `UIDevice.current.name`. On macOS it falls back to
    /// `Host.current().localizedName` and finally the hostname.
    static var localizedName: String {
        #if os(iOS)
        return UIDevice.current.name
        #elseif os(macOS)
        if let name = Host.current().localizedName, !name.isEmpty { return name }
        return Host.current().name ?? ProcessInfo.processInfo.hostName
        #else
        return "Unknown"
        #endif
    }
}

#if os(macOS)
// MARK: - Shared ISO8601 Formatters (macOS)
//
// Mirrors the iOS `ISO8601` helper in Helpers.swift so cross-platform
// Core files (SessionStore, CommandSender, AppState) can format/parse
// relay timestamps without an iOS-only import.

import Foundation

enum ISO8601 {
    static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static let withoutFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ string: String) -> Date? {
        withFractional.date(from: string) ?? withoutFractional.date(from: string)
    }

    static func now() -> String {
        withFractional.string(from: Date())
    }
}

/// Collapse runs of whitespace/newlines into a single space.
extension String {
    func collapseWhitespace() -> String {
        components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

/// Mirrors web `sessionTime()` — shows HH:mm if today, "yesterday", or "Xd ago".
enum SessionTimeFormatter {
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    static func format(_ iso: String) -> String {
        guard let date = ISO8601.parse(iso) else { return "" }
        let now = Date()
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return timeFormatter.string(from: date)
        }
        if calendar.isDateInYesterday(date) {
            return "Yesterday"
        }
        let dayDiff = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if dayDiff < 7 {
            return "\(dayDiff)d ago"
        }
        let thisYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let f = DateFormatter()
        f.dateFormat = thisYear ? "MMM d" : "MMM d, yyyy"
        return f.string(from: date)
    }
}
#endif
