/// KrakiPlatform — Cross-platform typealiases for UIKit / AppKit.
///
/// We share SwiftUI views between iOS and macOS targets. The view bodies
/// are platform-agnostic, but a handful of helpers (Color initializers,
/// haptics, pasteboard) reach down to the platform-native primitive.
/// Centralizing those here keeps the rest of `Shared/` free of `#if`
/// pollution.

import Foundation
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

/// Persists the user's last-used Device / Agent / Model / Reasoning-Effort
/// choices for the New Session form on both iOS and macOS.
///
/// `lastModel` is keyed by `deviceId:agentId` so each agent can remember a
/// different model. The device-only fallback preserves older single-agent
/// preferences from before multi-agent support.
enum SessionPrefs {
    private static let lastDeviceKey = "kraki:last-device"
    private static let lastAgentKey  = "kraki:last-agent"
    private static let lastModelKey  = "kraki:last-model"
    private static let lastEffortKey = "kraki:last-effort"

    static func lastDeviceId() -> String? {
        UserDefaults.standard.string(forKey: lastDeviceKey)
    }

    static func saveLastDevice(_ id: String) {
        UserDefaults.standard.set(id, forKey: lastDeviceKey)
    }

    static func lastAgentId(deviceId: String) -> String? {
        agentMap()[deviceId]
    }

    static func saveLastAgent(deviceId: String, agentId: String) {
        var map = agentMap()
        map[deviceId] = agentId
        UserDefaults.standard.set(map, forKey: lastAgentKey)
    }

    static func lastModel(deviceId: String, agentId: String?) -> String? {
        let map = modelMap()
        if let agentId, let model = map["\(deviceId):\(agentId)"] {
            return model
        }
        return map[deviceId]
    }

    static func saveLastModel(deviceId: String, agentId: String?, model: String) {
        var map = modelMap()
        let key = agentId.map { "\(deviceId):\($0)" } ?? deviceId
        map[key] = model
        UserDefaults.standard.set(map, forKey: lastModelKey)
    }

    static func lastEffort(model: String) -> ReasoningEffort? {
        guard let raw = effortMap()[model] else { return nil }
        return ReasoningEffort(rawValue: raw)
    }

    static func saveLastEffort(model: String, effort: ReasoningEffort) {
        var map = effortMap()
        map[model] = effort.rawValue
        UserDefaults.standard.set(map, forKey: lastEffortKey)
    }

    private static func agentMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: lastAgentKey) as? [String: String] ?? [:]
    }

    private static func modelMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: lastModelKey) as? [String: String] ?? [:]
    }

    private static func effortMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: lastEffortKey) as? [String: String] ?? [:]
    }
}
