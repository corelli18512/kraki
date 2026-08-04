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

#if os(macOS)
// The iOS Helpers.swift file is intentionally UIKit-only. Keep the same
// cached timestamp contract available to the macOS Core target here.
enum ISO8601 {
    static let withFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let withoutFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ string: String) -> Date? {
        withFractional.date(from: string) ?? withoutFractional.date(from: string)
    }

    static func now() -> String { withFractional.string(from: Date()) }
}
#endif

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
