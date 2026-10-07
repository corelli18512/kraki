/// PreferencesManager — Cross-device preference sync via head's
/// `update_preferences` / `preferences_updated` control-plane messages, plus
/// `update_voice_vocabulary` / `voice_vocabulary_updated` for words.
///
/// What's synced today
/// -------------------
/// - `theme` (`"system" | "light" | "dark"`) → mapped onto the same
///   `UserDefaults["colorScheme"]` key that `KrakiApp` watches via
///   `@AppStorage`. Setting the value here makes the next render tick
///   adopt the new colour scheme automatically.
/// - Custom Words → VoiceVocabularyStore, sent as add/edit/remove intents.
///   See docs/custom-words-sync.md.
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

    // Custom Words: silent account sync. Edits are flushed into the store's
    // persisted outbox 0.7 s after the last change and sent as one request;
    // the reply (the account's list) acknowledges it. No reply in 5 s: resend.
    // A resend after a lost reply re-applies the same intents (harmless unless
    // another device changed those words in between, then the resend wins).
    private var vocabularyWork: DispatchWorkItem?
    private var vocabularyInFlight: (id: String, count: Int)?
    private var vocabularyUser: String?

    init(appState: AppState) {
        self.appState = appState
        appState.voiceVocabularyStore.onChange = { [weak self] in self?.scheduleVocabularySend() }
    }

    /// Every auth_ok: adopt the account's list (also how a reconnect catches
    /// up) and send anything queued. `words` nil: this Head can't sync yet.
    func authenticateVocabulary(userID: String, words: [VoiceWord]?) {
        guard let store = appState?.voiceVocabularyStore else { return }
        vocabularyWork?.cancel()
        vocabularyInFlight = nil
        vocabularyUser = userID
        store.activate(userID: userID)
        store.syncSupported = words != nil
        if let words { store.receive(words) }
        scheduleVocabularySend(after: 0)
    }

    func resetVocabulary() {
        vocabularyWork?.cancel()
        vocabularyWork = nil
        vocabularyInFlight = nil
        vocabularyUser = nil
        appState?.voiceVocabularyStore.deactivate()
    }

    func receiveVocabulary(_ message: [String: Any]) {
        guard let appState, let user = vocabularyUser, appState.user?.id == user,
              let words = VoiceWord.decodeList(message["words"]) else { return }
        var acknowledged = 0
        if let request = vocabularyInFlight, message["requestId"] as? String == request.id {
            acknowledged = request.count
            vocabularyInFlight = nil
            vocabularyWork?.cancel()
        }
        appState.voiceVocabularyStore.receive(words, acknowledged: acknowledged)
        scheduleVocabularySend(after: 0)
    }

    private func scheduleVocabularySend(after delay: TimeInterval = 0.7) {
        // While a request is in flight its retry timer is pending; new edits
        // wait in the outbox and go out after the reply.
        guard vocabularyInFlight == nil else { return }
        vocabularyWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.sendVocabulary() }
        vocabularyWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func sendVocabulary() {
        guard let appState, appState.connectionStatus == .connected, let ws = appState.wsClient,
              let user = vocabularyUser, appState.user?.id == user else { return }
        let store = appState.voiceVocabularyStore
        guard store.syncSupported else { return }
        store.flush()
        // Only acknowledgements remove ops from the front, so a resend covers
        // exactly the same ops as the request it repeats.
        let count = vocabularyInFlight?.count ?? min(store.outbox.count, 200)
        guard count > 0 else { return }
        let id = vocabularyInFlight?.id ?? UUID().uuidString.lowercased()
        vocabularyInFlight = (id, count)
        guard let data = try? JSONSerialization.data(withJSONObject: [
                "type": "update_voice_vocabulary", "requestId": id,
                "ops": store.outbox.prefix(count).map(\.json),
              ]), let text = String(data: data, encoding: .utf8) else { return }
        ws.sendRaw(text)
        let work = DispatchWorkItem { [weak self] in self?.sendVocabulary() }
        vocabularyWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
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
            // Theme is best-effort. Custom Words uses the separate durable,
            // account-scoped outbox above rather than relying on this path.
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
    /// The relay value is authoritative. `system` remains portable because
    /// each client resolves it against its own operating-system appearance.
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
            if current != scheme.rawValue {
                defaults.set(scheme.rawValue, forKey: Self.themeKey)
            }
        }

        // `internal` and `channel` keys are intentionally ignored on
        // iOS for now. See the file header for the rationale.
    }
}
