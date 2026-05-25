#if os(iOS)
/// PreferencesManager — Cross-device preference sync via head's
/// `update_preferences` / `preferences_updated` control-plane messages.
///
/// What's synced today
/// -------------------
/// - `theme` (`"system" | "light" | "dark"`) → mapped onto the same
///   `UserDefaults["colorScheme"]` key that `KrakiApp` watches via
///   `@AppStorage`. Setting the value here makes the next render tick
///   adopt the new colour scheme automatically.
///
/// Future keys the protocol supports but iOS deliberately ignores:
/// - `internal: Bool` — debug-log verbosity. Honour when we wire KLog.
/// - `channel: String` — release channel. Not relevant until iOS gains
///   a multi-channel mechanism.
///
/// Echo-loop guard
/// ---------------
/// `applyRemote(_:)` writes preferences to UserDefaults; `SettingsView`
/// fires `onChange` on the `@AppStorage` binding, which would normally
/// pipe the new value back to the relay. To prevent the loop we set
/// `isApplyingRemote = true` for one runloop tick around the write.
/// Callers read `isApplyingRemote` and skip the upstream send when set.

import Foundation
import Observation

@Observable
final class PreferencesManager {

    /// `true` while we're applying a server-originated preference. The
    /// Settings view's `onChange` handler checks this and skips the
    /// upstream `update_preferences` so we don't echo back what we
    /// just received.
    private(set) var isApplyingRemote: Bool = false

    private weak var appState: AppState?
    private static let themeKey = "colorScheme"

    init(appState: AppState) {
        self.appState = appState
    }

    // MARK: - Outbound (Settings → relay)

    /// Send a theme change up to head so the user's other devices
    /// (web, other phones) see it on their next reconnect.
    func sendTheme(_ scheme: AppColorScheme) {
        // Match the JSON enum the web client + head expect: theme is
        // stored as one of `"system" | "light" | "dark"`.
        sendPreferences(["theme": scheme.rawValue])
    }

    /// Generic helper for any preference patch. Always merges
    /// server-side (head does an object-spread), so we only need to
    /// send the diff.
    func sendPreferences(_ prefs: [String: Any]) {
        guard let ws = appState?.wsClient else { return }
        guard appState?.connectionStatus == .connected else {
            // Not connected — preference will be re-sent on next
            // auth_ok via the local-storage hydrate path. Web does
            // the same: local takes precedence on cold boot, then a
            // single `update_preferences` flushes the diff upstream.
            return
        }
        let message: [String: Any] = [
            "type": "update_preferences",
            "preferences": prefs,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let str = String(data: data, encoding: .utf8) else { return }
        ws.sendRaw(str)
    }

    // MARK: - Inbound (auth_ok / preferences_updated → local state)

    /// Apply a `preferences` blob received from the relay.
    ///
    /// Called from `AuthManager.handleAuthOk` (cold hydrate) and
    /// `MessageRouter` on `preferences_updated` (live sync from
    /// other devices). Unknown keys are silently ignored, matching
    /// the protocol's forward-compatibility contract.
    ///
    /// **`theme == "system"` is sticky** — when the local preference
    /// is already System, we deliberately ignore any cloud-pushed
    /// theme value. The intent is that "System" expresses
    /// "follow THIS device's OS preference"; overriding it with
    /// another device's Light/Dark choice would silently break the
    /// user's chosen behaviour. Users opt back into sync by
    /// explicitly picking Light or Dark again.
    func applyRemote(_ prefs: [String: Any]) {
        isApplyingRemote = true
        defer {
            // Clear on the next runloop tick so any pending
            // `onChange(of: selectedScheme)` from `@AppStorage` has
            // a chance to read the flag before it resets.
            DispatchQueue.main.async { [weak self] in
                self?.isApplyingRemote = false
            }
        }

        if let themeString = prefs["theme"] as? String,
           let scheme = AppColorScheme(rawValue: themeString) {
            let defaults = UserDefaults.standard
            let current = defaults.string(forKey: Self.themeKey)
            // Sticky-System guard: stay on system regardless of what
            // the cloud says. See doc-comment above. Note: this only
            // skips the THEME assignment — any later preference keys
            // we add to this method must still run for system-theme
            // users, so we use a local skip rather than `return`-ing
            // out of the whole function.
            let skipTheme = (current == AppColorScheme.system.rawValue)
            if !skipTheme, current != scheme.rawValue {
                defaults.set(scheme.rawValue, forKey: Self.themeKey)
            }
        }

        // `internal` and `channel` keys are intentionally ignored on
        // iOS for now. See the file header for the rationale.
    }
}

#endif
