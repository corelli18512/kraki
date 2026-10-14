/// Steer placement (client side only, no protocol change).
///
/// A steer joins the running turn, but the agent reads it only at its next
/// step boundary. Until then the live card keeps streaming the segment it was
/// writing before the steer, so it stays above the steer row and keeps growing
/// there. When the agent starts a new segment (Tentacle `reset`, or words after
/// an empty draft) the card moves below the steer. The card is never split or
/// copied: only its row position differs, and it ends with the turn as always,
/// so the concluding reply lands below the steer. A reconnect snapshot carries
/// no placement and shows the card last.

import Foundation

extension MessageStore {
    struct SteerPlacement: Equatable {
        /// The steer the card is drawn above (its clientId, or the echoed row id).
        var anchor: String?
        /// Steers the card has already gone below this turn. A steer's echo
        /// can arrive after the agent's next segment began (Tentacle persists
        /// it when the agent takes it); it must not pull the card back up.
        var passed: Set<String> = []

        mutating func followSteer() {
            if let anchor { passed.insert(anchor) }
            anchor = nil
        }
    }

    /// A steer appeared (its local bubble, or another device's echo): keep the
    /// visible card above it. The first steer of the segment wins, so a later
    /// steer or the echo of the same one changes nothing, and a steer the card
    /// already went below never anchors it again.
    func placeCardAboveSteer(_ sessionId: String, anchor: String) {
        guard var card = cards[sessionId], card.steer.anchor == nil, !card.steer.passed.contains(anchor),
              !card.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || card.action != nil else { return }
        card.steer.anchor = anchor
        cards[sessionId] = card
    }

    /// A persisted `user_message` begins its card turn. A steer sent from
    /// another device is first seen here.
    func beginCardTurn(_ sessionId: String, userMessage payload: [String: Any]?, seq: Int?) {
        let delivery = payload?["delivery"] as? String
        beginCardTurn(sessionId, delivery: delivery)
        guard delivery == "steer" else { return }
        placeCardAboveSteer(sessionId, anchor: payload?["clientId"] as? String ?? "\(sessionId):\(seq ?? 0)")
    }
}

extension MessageStore.SessionCard {
    /// A new segment (reset, or words after an empty draft) follows the steer.
    mutating func followSteerOnNewSegment(reset: Bool, content: String) {
        if reset || (text.isEmpty && !content.isEmpty) { steer.followSteer() }
    }

    /// The steer the card is drawn above, if any.
    var aboveSteer: String? { steer.anchor }

    /// Where the live card row goes among the list `rows`: right above its
    /// steer (the pending bubble or the echoed row, matched by clientId or row
    /// id), else last. A steer not among the rows (paged out, or its unsent
    /// bubble deleted) puts the card last.
    func rowIndex(in rows: [ChatMessage]) -> Int {
        guard let anchor = aboveSteer else { return rows.count }
        return rows.firstIndex { row in
            (row.type == "user_message" || row.type == "pending_input")
                && (row.payload["clientId"]?.stringValue == anchor || row.id == anchor)
        } ?? rows.count
    }
}
