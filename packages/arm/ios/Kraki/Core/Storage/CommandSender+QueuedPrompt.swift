/// A prompt that reaches Tentacle while a turn is still running is persisted
/// (and echoed) only when it dispatches, after that turn ends.

import Foundation

extension CommandSender {
    /// Its missing echo is not a stall: do not count time toward a resend or
    /// "Awaiting confirmation" while the session's turn is still running.
    /// A steer is persisted on arrival, so it keeps the normal clock.
    func waitsBehindRunningTurn(_ sessionId: String, clientId: String) -> Bool {
        guard outbox[sessionId]?[clientId]?.payload["delivery"]?.stringValue != "steer",
              let state = appState?.sessionStore.sessions[sessionId]?.state else { return false }
        return state == .active || state == .compacting
    }
}
