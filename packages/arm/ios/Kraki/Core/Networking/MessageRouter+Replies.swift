import Foundation

/// Reply-turn bookkeeping for `reply.summary` (see ReplyTracker), plus the
/// turn-ending `turn_status` handler it shares the turn lifecycle with.
extension MessageRouter {
    static func makeReplyTracker() -> ReplyTracker {
        let tracker = ReplyTracker()
        #if KRAKI_DIAG
        tracker.onSummary = { reply in
            var f: [DiagField: DiagValue] = [
                .kind: .tag(reply.kind.rawValue), .outcome: .tag(reply.outcome.rawValue),
                .durationMs: .number(reply.durationMs), .deltas: .int(reply.deltas),
                .maxGapMs: .number(reply.maxGapMs), .stalls: .int(reply.stalls),
            ]
            if let v = reply.firstActivityMs { f[.firstActivityMs] = .number(v) }
            if let v = reply.firstTextMs { f[.firstTextMs] = .number(v) }
            KrakiDiag.record(.reply, f)
        }
        #endif
        return tracker
    }

    /// Called for every session message before it is applied. Runs before the
    /// `user_message` echo is ingested: landing it clears the outbox entry
    /// that proves this device sent it. Live deltas/card actions reach here
    /// only for the subscribed (open) conversation.
    func noteReplyProgress(_ type: String, sessionId: String, payload: [String: Any]?) {
        guard let appState else { return }
        switch type {
        case "user_message":
            // A turn this device started while the user is here to wait for
            // it. A steer stays inside the running turn.
            guard let clientId = payload?["clientId"] as? String,
                  payload?["delivery"] as? String != "steer", !appState.isInBackground,
                  appState.commandSender?.outbox[sessionId]?[clientId] != nil else { return }
            replyMetrics.started(sessionId, kind: payload?["answerTo"] is String ? .answer : .typed)
        case "agent_message_delta":
            guard payload?["content"] is String else { return }
            replyMetrics.delta(sessionId, reset: payload?["reset"] as? Bool ?? false)
        case "card_action", "tool_start":
            replyMetrics.activity(sessionId)
        case "agent_message":
            replyMetrics.message(sessionId)
        case "idle":
            replyMetrics.finish(sessionId, .completed)
        case "turn_status":
            let failed = ((payload?["action"] as? [String: Any])?["type"] as? String) == "failed"
            replyMetrics.finish(sessionId, failed ? .failed : .stopped)
        case "interrupted_turn", "session_ended":
            replyMetrics.finish(sessionId, .stopped)
        default:
            break
        }
    }

    /// A turn ended without a final message: failed or stopped.
    func handleTurnStatus(_ sessionId: String, json: Data, payload: [String: Any]?, timestamp: String?) {
        guard let appState else { return }
        appState.messageProvider?.ingestTailCandidate(sessionId, json: json)
        appState.messageStore.clearRuntimeStatusIfCompacting(sessionId)
        appState.messageStore.endCardTurn(sessionId)
        let action = payload?["action"] as? [String: Any]
        let failed = (action?["type"] as? String) == "failed"
        let draft = payload?["draft"] as? String ?? ""
        updatePreview(sessionId,
                      text: draft.isEmpty ? (failed ? "Turn failed" : "Stopped") : draft,
                      type: failed ? "error" : "agent",
                      timestamp: timestamp)
    }
}
