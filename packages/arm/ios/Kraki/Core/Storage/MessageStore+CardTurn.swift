/// Card-turn transitions that live outside `MessageStore.swift` (kept there at its size cap).

import Foundation

extension MessageStore {
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
        if card.action == nil {
            cards.removeValue(forKey: sessionId)
        } else {
            cards[sessionId] = card
        }
    }
}
