import Foundation

/// Live-only session signals: never persisted, applied to in-memory state.
extension MessageRouter {
    func handleLiveSessionSignal(_ type: String, sessionId: String, payload: [String: Any]?) {
        guard let appState else { return }
        switch type {
        case "question_withdrawn":
            // The agent stopped waiting for this question (timeout, cancel):
            // close its choices now rather than at the next spine row (K-022).
            guard let questionId = payload?["questionId"] as? String else { return }
            appState.messageStore.withdrawQuestion(sessionId, questionId: questionId)
        default:
            break
        }
    }
}
