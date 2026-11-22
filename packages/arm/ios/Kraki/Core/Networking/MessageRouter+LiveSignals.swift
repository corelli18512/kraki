import Foundation

/// Live-only session signals: never persisted, applied to in-memory state.
extension MessageRouter {
    /// `client_features` entry that opts this app in to `question_withdrawn`;
    /// Tentacle sends the signal only to apps that declared it.
    static let questionWithdrawnFeature = "question_withdrawn"

    func handleLiveSessionSignal(_ type: String, sessionId: String, payload: [String: Any]?) {
        guard let appState else { return }
        switch type {
        case "question_withdrawn":
            // The question is no longer answerable here (timeout, cancel, or
            // the agent answered it itself): close its choices now rather
            // than at the next spine row (K-022).
            guard let questionId = payload?["questionId"] as? String else { return }
            appState.messageStore.withdrawQuestion(sessionId, questionId: questionId)
        default:
            break
        }
    }
}
