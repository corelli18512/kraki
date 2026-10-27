/// AppLanguage — UI language support for iOS and macOS.
///
/// Strings live in `Resources/Localization/Localizable.xcstrings` (String
/// Catalog). SwiftUI `Text("…")`, `Button("…")`, `Label("…", …)` etc. look
/// literals up automatically; for a `String` built in code use
/// `String(localized: "…")`, and for model/enum copy return
/// `LocalizedStringResource`. Never hand-build "5m ago" / "3 items": use
/// `KrakiFormat` and catalog plural variants.
///
/// Language choice:
///   • default: follows the system (Apple's per-app language resolution);
///   • iOS: Settings › Language opens the app's page in the system Settings
///     app, where iOS shows the per-app "Language" picker (no in-app state);
///   • macOS: in-app picker writes the app-domain `AppleLanguages` override
///     and offers to relaunch (Foundation resolves bundles at launch).
/// The choice is per device and never synced.
///
/// Adding a language: add it to `supported` and translate it in the catalogs
/// (Xcode adds the region to the project); `scripts/l10n-check.mjs` reports
/// missing translations.

import Foundation
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case english = "en"
    case simplifiedChinese = "zh-Hans"

    var id: String { rawValue }

    /// Shown in its own language so it is findable from any UI language.
    var nativeName: String {
        switch self {
        case .english: "English"
        case .simplifiedChinese: "简体中文"
        }
    }

    /// The language the running process actually uses.
    static var current: AppLanguage {
        let code = Bundle.main.preferredLocalizations.first ?? "en"
        return AppLanguage(rawValue: code) ?? .english
    }

    #if os(macOS)
    private static let overrideKey = "AppleLanguages"
    /// Whether the user picked a fixed language in-app (nil = follow system).
    static var override: AppLanguage? { override(in: .standard, domain: Bundle.main.bundleIdentifier ?? "") }

    /// The language an app-domain `AppleLanguages` list forces. Values written
    /// outside the picker (`zh-Hans-CN`, `en-GB`, System Settings) resolve the
    /// way the bundle does, so the picker shows what the app actually uses.
    static func override(in defaults: UserDefaults, domain: String) -> AppLanguage? {
        guard let list = storedOverride(in: defaults, domain: domain), !list.isEmpty else { return nil }
        let resolved = Bundle.preferredLocalizations(from: allCases.map(\.rawValue), forPreferences: list).first
        return resolved.flatMap(AppLanguage.init(rawValue:))
    }

    /// Read only our own domain: UserDefaults.standard also sees the global
    /// AppleLanguages, which is the system list, not an override.
    private static func storedOverride(in defaults: UserDefaults, domain: String) -> [String]? {
        defaults.persistentDomain(forName: domain)?[overrideKey] as? [String]
    }

    /// Takes effect at the next launch. Returns true if it changed.
    @discardableResult
    static func setOverride(_ language: AppLanguage?) -> Bool {
        setOverride(language, in: .standard, domain: Bundle.main.bundleIdentifier ?? "")
    }

    @discardableResult
    static func setOverride(_ language: AppLanguage?, in defaults: UserDefaults, domain: String) -> Bool {
        let stored = storedOverride(in: defaults, domain: domain)
        if let language {
            guard stored != [language.rawValue] else { return false }
            defaults.set([language.rawValue], forKey: overrideKey)
        } else {
            // System Default clears any stored list, including one the picker
            // can't name.
            guard stored != nil else { return false }
            defaults.removeObject(forKey: overrideKey)
        }
        return true
    }

    /// Relaunch the app so the new language applies everywhere.
    @MainActor
    static func relaunch() {
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { application, error in
            // Quit only once the new instance is running; if the launch
            // failed, keep this one (the choice still applies next launch).
            guard application != nil, error == nil else { return }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
    #endif

    #if os(iOS)
    /// Opens Kraki's page in Settings, which has iOS's per-app Language picker.
    @MainActor
    static func openSystemLanguageSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
    #endif
}

/// Locale-aware formatting shared by iOS and macOS.
enum KrakiFormat {
    /// "now" / "5m ago" / "3h ago" (en) — "现在" / "5分钟前" (zh-Hans).
    static func relative(_ date: Date, now: Date = .now, locale: Locale = .current) -> String {
        if abs(now.timeIntervalSince(date)) < 60 {
            return String(localized: "time.justNow", defaultValue: "just now", comment: "Relative time under a minute")
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .abbreviated
        formatter.dateTimeStyle = .numeric
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
