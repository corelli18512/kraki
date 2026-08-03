#if os(macOS)
/// AppColorScheme — Cross-platform color-scheme enum backed by
/// UserDefaults["colorScheme"] (via @AppStorage). Lives in Shared/ so
/// both iOS Settings and macOS Preferences General pane can read/write
/// it without dragging in each other's view files.
///
/// PreferencesManager.applyRemote(_:) writes here when head pushes a
/// `preferences_updated` for theme — `@AppStorage`'s underlying
/// UserDefaults observer triggers a SwiftUI re-render automatically.

import SwiftUI

enum AppColorScheme: String, CaseIterable {
    case system
    case light
    case dark

    /// SwiftUI's modifier expects an Optional — nil = follow system.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// Convenience alias matching the name MacApp.swift uses.
    var scheme: ColorScheme? { colorScheme }
}
#endif
