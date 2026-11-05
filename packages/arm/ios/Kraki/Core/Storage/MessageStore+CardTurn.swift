/// Card-turn transitions that live outside `MessageStore.swift` (kept there at its size cap).

import Foundation

extension MessageStore {
    /// An action that only says what happened last (a completed tool, a
    /// decided permission): narration that resumes supersedes it.
    static func isSettledTail(_ action: ChatMessage) -> Bool {
        action.type == "tool_complete" || isResolvedPrompt(action)
    }

    /// Reopen transient draft/action state for an accepted user input. A normal
    /// prompt starts a fresh turn and clears stale card state; a steer is a
    /// visible interjection inside the current lifecycle and must preserve the
    /// active draft/action while only reopening the late-frame gate.
    func beginCardTurn(_ sessionId: String, delivery: String? = nil) {
        closedCardTurns.remove(sessionId)
        cardEndsAtSeq.removeValue(forKey: sessionId)
        if delivery != "steer" { cards.removeValue(forKey: sessionId) }
    }

    /// Permanently retire transient state for the concluded turn. Late WS
    /// coalescing or request_card snapshots are ignored until beginCardTurn.
    func endCardTurn(_ sessionId: String) {
        if !closedCardTurns.contains(sessionId) { closedCardTurns.insert(sessionId) }
        if cards[sessionId] != nil { cards.removeValue(forKey: sessionId) }
        if cardEndsAtSeq[sessionId] != nil { cardEndsAtSeq.removeValue(forKey: sessionId) }
    }

    /// An idle authority (session_list digest, idle subscription snapshot) for
    /// a turn whose concluding bubble this device has not caught up to yet.
    /// Close the turn now, but keep its last draft until the spine reaches
    /// `seq`: the bubble that lands then replaces the draft in place. Removing
    /// the draft first made the reply vanish and slide in again (K-013).
    func endCardTurn(_ sessionId: String, afterCatchUpTo seq: Int) {
        guard cards[sessionId] != nil, persistedHead(sessionId) < seq else {
            endCardTurn(sessionId)
            return
        }
        closedCardTurns.insert(sessionId)
        cardEndsAtSeq[sessionId] = seq
    }

    /// The kept draft of a concluded turn is retired in the same main-thread
    /// step that persists its concluding bubble.
    func retireCardIfCaughtUp(_ sessionId: String) {
        guard let end = cardEndsAtSeq[sessionId], persistedHead(sessionId) >= end else { return }
        endCardTurn(sessionId)
    }

    /// Restore the gate from persisted conversation truth when opening a DB
    /// window. `session.state == active` is not sufficient because a reconnect
    /// snapshot may race after the preceding turn already concluded. A question
    /// `agent_message` is not a boundary: it does not conclude the turn.
    func restoreCardTurnGate(_ sessionId: String, from messages: [ChatMessage]) {
        guard let boundary = messages.last(where: {
            ["user_message", "agent_message", "turn_status", "interrupted_turn",
             "system_message", "idle", "session_ended"].contains($0.type) && $0.questionSpec == nil
        }) else { return }
        if boundary.type == "user_message" {
            // A turn kept for its catch-up stays closed until the bubble lands.
            if cardEndsAtSeq[sessionId] == nil { closedCardTurns.remove(sessionId) }
        } else {
            endCardTurn(sessionId)
        }
    }

    /// A concluding `agent_message` ends the card turn. A question
    /// `agent_message` only lands the lead-in draft on the spine: Tentacle
    /// keeps the turn (and an unresolved permission from a parallel subagent)
    /// open, so the gate stays open and the action slot is kept.
    func landAgentMessage(_ sessionId: String, isQuestion: Bool) {
        guard isQuestion else {
            endCardTurn(sessionId)
            return
        }
        guard var card = cards[sessionId] else { return }
        card.text = ""
        // The question landed below the steer; what follows goes there too.
        card.steer.followSteer()
        if card.action == nil {
            cards.removeValue(forKey: sessionId)
        } else {
            cards[sessionId] = card
        }
    }
}
