/// PreferencesManager — Cross-device preference sync via head's
/// `update_preferences` / `preferences_updated` control-plane messages, plus
/// revisioned `update_voice_vocabulary` / `voice_vocabulary_updated` for words.
///
/// What's synced today
/// -------------------
/// - `theme` (`"system" | "light" | "dark"`) → mapped onto the same
///   `UserDefaults["colorScheme"]` key that `KrakiApp` watches via
///   `@AppStorage`. Setting the value here makes the next render tick
///   adopt the new colour scheme automatically.
/// - Custom Words → account-scoped VoiceVocabularyStore and durable outbox.
///   See docs/custom-words-sync.md for migration, conflicts and privacy.
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

    private var vocabularyWork: DispatchWorkItem?
    private var vocabularyRequest: (id: String, changes: [VoiceVocabularyChange])?
    private var vocabularyAccount: String?

    init(appState: AppState) {
        self.appState = appState
        appState.voiceVocabularyStore.onChange = { [weak self] in self?.scheduleVocabularySend() }
    }

    /// Auth is both capability negotiation and a reconnect resync. Never send
    /// queued account data to an older head or before the identity is known.
    func authenticateVocabulary(userID: String, relay: String, snapshot: VoiceVocabularySnapshot?) {
        guard let appState else { return }
        vocabularyWork?.cancel()
        vocabularyRequest = nil
        let store = appState.voiceVocabularyStore
        store.activate(userID: userID, relay: relay)
        vocabularyAccount = store.accountKey
        store.syncSupported = snapshot != nil
        if let snapshot { store.receive(snapshot) }
        scheduleVocabularySend()
    }

    func resetVocabulary() {
        vocabularyWork?.cancel()
        vocabularyWork = nil
        vocabularyRequest = nil
        vocabularyAccount = nil
        appState?.voiceVocabularyStore.deactivate()
    }

    func receiveVocabulary(_ message: [String: Any]) {
        guard let appState, let account = vocabularyAccount,
              appState.voiceVocabularyStore.accountKey == account,
              let user = appState.user,
              account == VoiceVocabularyStore.accountKey(userID: user.id, relay: appState.relayURL) else { return }
        let store = appState.voiceVocabularyStore
        let request = vocabularyRequest
        let isReply = request != nil && message["requestId"] as? String == request?.id
        if let snapshot = VoiceVocabularySnapshot.decode(message["vocabulary"]) {
            store.receive(snapshot, sent: isReply ? request!.changes : [],
                          results: isReply ? message["results"] as? [[String: Any]] ?? [] : [])
        } else if isReply, message["error"] != nil {
            store.reject(request!.changes)
        } else { return }
        if isReply {
            vocabularyRequest = nil
            vocabularyWork?.cancel()
        }
        scheduleVocabularySend()
    }

    private func scheduleVocabularySend() {
        // Keep the retry timer while a batch is in flight; subsequent typing
        // updates the durable outbox, not the already-sent request.
        guard vocabularyRequest == nil else { return }
        vocabularyWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.sendVocabulary() }
        vocabularyWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
    }

    private func sendVocabulary() {
        guard let appState, appState.connectionStatus == .connected,
              let user = appState.user, let ws = appState.wsClient,
              vocabularyAccount == VoiceVocabularyStore.accountKey(userID: user.id, relay: appState.relayURL),
              appState.voiceVocabularyStore.syncSupported else { return }
        let store = appState.voiceVocabularyStore
        if vocabularyRequest == nil {
            let changes = Array(store.syncState.pending.filter { store.syncState.blocked[$0.changeId] == nil }.prefix(100))
            guard !changes.isEmpty else { return }
            vocabularyRequest = (UUID().uuidString.lowercased(), changes)
        }
        guard let request = vocabularyRequest,
              let data = try? JSONSerialization.data(withJSONObject: [
                "type": "update_voice_vocabulary", "requestId": request.id,
                "changes": request.changes.map(\.json),
              ]), let text = String(data: data, encoding: .utf8) else { return }
        // Own durable retry queue, never WebSocketClient's cross-reconnect queue.
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
