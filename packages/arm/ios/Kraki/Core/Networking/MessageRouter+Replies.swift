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
        replyMetrics.expire()
        switch type {
        case "user_message":
            // A turn this device started while the user is here to wait for
            // it. A steer stays inside the running turn.
            guard let clientId = payload?["clientId"] as? String,
                  payload?["delivery"] as? String != "steer", !appState.isInBackground,
                  appState.commandSender?.outbox[sessionId]?[clientId] != nil else { return }
            replyMetrics.started(sessionId, kind: payload?["answerTo"] is String ? .answer : .typed)
        case "agent_message_delta":
            guard let content = payload?["content"] as? String else { return }
            replyMetrics.delta(sessionId, reset: payload?["reset"] as? Bool ?? false, empty: content.isEmpty)
        case "card_action":
            // A null action clears the slot (e.g. on stop): not reply activity.
            guard payload?["action"] is [String: Any] else { return }
            replyMetrics.activity(sessionId)
        case "tool_start":
            replyMetrics.activity(sessionId)
        case "agent_message":
            replyMetrics.message(sessionId)
        case "idle":
            switch payload?["reason"] as? String {
            case "aborted": replyMetrics.finish(sessionId, .stopped)
            case "failed": replyMetrics.finish(sessionId, .failed)
            default: replyMetrics.finish(sessionId, .completed)
            }
        case "turn_status":
            let failed = ((payload?["action"] as? [String: Any])?["type"] as? String) == "failed"
            replyMetrics.finish(sessionId, failed ? .failed : .stopped)
        case "interrupted_turn", "session_ended", "session_deleted":
            replyMetrics.finish(sessionId, .stopped)
        default:
            break
        }
    }

    /// After session_list reconciliation: clear state of removed sessions and
    /// close reply turns whose end was missed.
    func sessionListApplied(removed: Set<String>, idle: Set<String>) {
        guard let appState else { return }
        for sid in removed {
            appState.messageStore.clearRuntimeStatus(sid)
            appState.messageStore.clearCard(sid)
        }
        appState.noteSessionListApplied()
        reconcileReplies(idle: idle, removed: removed)
    }

    /// Reconnect authority (session_list): a tracked turn whose session is now
    /// idle or gone ended while we were not listening.
    func reconcileReplies(idle: Set<String>, removed: some Sequence<String>) {
        replyMetrics.expire()
        for sid in removed { replyMetrics.missedEnd(sid) }
        for sid in replyMetrics.openSessions where idle.contains(sid) { replyMetrics.missedEnd(sid) }
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
                      text: draft.isEmpty ? (failed ? String(localized: "Turn failed") : String(localized: "Stopped")) : draft,
                      type: failed ? "error" : "agent",
                      timestamp: timestamp)
    }
}
