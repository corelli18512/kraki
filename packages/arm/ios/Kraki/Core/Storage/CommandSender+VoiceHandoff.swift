import Foundation

extension CommandSender {
    /// Session creation and voice correction may finish in either order. The
    /// shared outbox owns the bubble throughout; only its route changes.
    func resolveVoicePlaceholder(_ placeholder: String, sessionID: String) {
        guard pendingVoicePlaceholders.remove(placeholder) != nil, let appState else { return }
        appState.iosVoiceComposer.transferStagedSession(from: placeholder, to: sessionID)
        let store = appState.sessionStore
        if let draft = store.drafts[placeholder], !draft.isEmpty {
            store.setDraft(sessionID, VoiceDraftMerger.merge(existing: store.drafts[sessionID] ?? "", final: draft))
            store.setDraft(placeholder, "")
        }
        movePendingInputs(from: placeholder, to: sessionID)
    }

    /// A failed/timed-out create cannot send speech later. Keep all heard text
    /// in the new-session draft, including a follow-up typed while waiting.
    func recoverVoicePlaceholder(_ placeholder: String) {
        guard pendingVoicePlaceholders.remove(placeholder) != nil, let appState else { return }
        if appState.iosVoiceComposer.sessionID == placeholder { appState.iosVoiceComposer.retireKeepingDraft() }
        for input in pendingInputs(placeholder) {
            let clientID = input.payload["clientId"]?.stringValue ?? ""
            recoverNewSessionText(originalText(sessionId: placeholder, clientId: clientID) ?? input.content ?? "")
        }
        if let draft = appState.sessionStore.drafts[placeholder], !draft.isEmpty {
            recoverNewSessionText(draft)
            appState.sessionStore.setDraft(placeholder, "")
        }
        clearAllPending(placeholder)
    }

    func recoverNewSessionText(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text != "…",
              let store = appState?.sessionStore else { return }
        let key = IOSVoiceComposer.newSessionDraftID
        let existing = store.drafts[key] ?? ""
        store.setDraft(key, existing.isEmpty ? text : existing + "\n" + text)
    }

    /// A timed-out create that succeeded after all: its first message moves
    /// from the new-session draft (where the timeout put it) to the Session,
    /// unless the user has since edited or sent that draft.
    func withdrawRecoveredNewSessionText(_ text: String) {
        guard !text.isEmpty, let store = appState?.sessionStore else { return }
        let key = IOSVoiceComposer.newSessionDraftID
        let existing = store.drafts[key] ?? ""
        if existing == text {
            store.setDraft(key, "")
        } else if existing.hasSuffix("\n" + text) {
            store.setDraft(key, String(existing.dropLast(text.count + 1)))
        }
    }
}
