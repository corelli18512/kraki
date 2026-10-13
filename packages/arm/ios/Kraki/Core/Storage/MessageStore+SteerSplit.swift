/// Steer display (client side only, no protocol change).
///
/// While the agent streams a draft, a steer joins the running turn. Tentacle
/// keeps streaming the same cumulative draft segment, so without a split the
/// live bubble (always the last row) grows below the steer and the agent's
/// earlier words read like an answer to it. Instead, the draft as it stood
/// when the steer appeared is frozen into a plain agent bubble right above the
/// steer, and the live bubble below it shows only the text that followed.
/// The split lives on the card, so it ends with the turn: the concluding
/// reply lands below the steer and the frozen bubbles go (their words are in
/// the turn's Steps, as for any turn).

import Foundation

extension MessageStore {
    struct SteerSplit: Equatable {
        struct Frozen: Equatable {
            /// The steer's clientId (its pending and echoed rows carry it), or
            /// the echoed row's id when it has none.
            let anchor: String
            let text: String
        }
        /// Oldest first, one per steer that interrupted visible words.
        var frozen: [Frozen] = []
        /// The card text when the latest steer appeared.
        var consumed = ""
    }

    /// A steer joined the running turn: freeze what the live bubble shows now
    /// above it. Idempotent per steer (local send, then its echo).
    func splitCardAtSteer(_ sessionId: String, anchor: String) {
        guard var card = cards[sessionId],
              !card.steerSplit.frozen.contains(where: { $0.anchor == anchor }) else { return }
        let visible = card.afterLatestSteer.text
        guard !visible.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        card.steerSplit.frozen.append(.init(anchor: anchor, text: visible))
        card.steerSplit.consumed = card.text
        cards[sessionId] = card
    }

    /// A persisted `user_message` begins its card turn. A steer also splits
    /// the draft (a steer sent from another device is first seen here).
    func beginCardTurn(_ sessionId: String, userMessage payload: [String: Any]?, seq: Int?) {
        let delivery = payload?["delivery"] as? String
        beginCardTurn(sessionId, delivery: delivery)
        guard delivery == "steer" else { return }
        splitCardAtSteer(sessionId, anchor: payload?["clientId"] as? String ?? "\(sessionId):\(seq ?? 0)")
    }
}

extension MessageStore.SessionCard {
    /// The card as the live bubble shows it: only the draft that followed the
    /// latest steer. A new draft segment (Tentacle `reset`) no longer starts
    /// with the frozen text and shows whole.
    var afterLatestSteer: Self {
        let consumed = steerSplit.consumed
        guard !consumed.isEmpty, text.hasPrefix(consumed) else { return self }
        var card = self
        card.text = String(text.dropFirst(consumed.count).drop(while: { $0.isWhitespace }))
        return card
    }

    /// `rows` with each frozen draft placed right above its steer. A steer
    /// not among the rows (paged out, or its unsent bubble deleted) gets none.
    func placingFrozenSteerDrafts(in rows: [ChatMessage], sessionId: String) -> [ChatMessage] {
        guard !steerSplit.frozen.isEmpty else { return rows }
        let byAnchor = Dictionary(steerSplit.frozen.map { ($0.anchor, $0) }, uniquingKeysWith: { first, _ in first })
        var result: [ChatMessage] = []
        result.reserveCapacity(rows.count + byAnchor.count)
        for row in rows {
            if row.type == "user_message" || row.type == "pending_input",
               let frozen = row.payload["clientId"]?.stringValue.flatMap({ byAnchor[$0] }) ?? byAnchor[row.id] {
                result.append(Self.frozenSteerDraft(frozen, sessionId: sessionId))
            }
            result.append(row)
        }
        return result
    }

    /// A plain agent bubble. Its id (seq 0 + clientId) is stable per steer
    /// and, like a pending row, never counts as a new arrival.
    static func frozenSteerDraft(_ frozen: MessageStore.SteerSplit.Frozen, sessionId: String) -> ChatMessage {
        ChatMessage(type: "agent_message", seq: 0, sessionId: sessionId, deviceId: nil, timestamp: nil,
                    payload: ["content": AnyCodable(frozen.text),
                              "clientId": AnyCodable("steer-split:\(frozen.anchor)")])
    }
}
