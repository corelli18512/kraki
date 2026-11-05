/// A prompt that reaches Tentacle while a turn is still running is persisted
/// (and echoed) only when it dispatches, after that turn ends.

import Foundation

extension CommandSender {
    /// Its missing echo is not a stall: do not count time toward a resend or
    /// "Awaiting confirmation" while the session's turn is still running.
    /// A steer and an answer to the agent's question are persisted on arrival
    /// (the question keeps its turn running), so they keep the normal clock.
    func waitsBehindRunningTurn(_ sessionId: String, clientId: String) -> Bool {
        guard let pending = outbox[sessionId]?[clientId],
              pending.payload["delivery"]?.stringValue != "steer",
              pending.payload["answerTo"] == nil,
              let state = appState?.sessionStore.sessions[sessionId]?.state else { return false }
        return state == .active || state == .compacting
    }
}
