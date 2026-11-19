import Foundation

// MARK: - Outbox queries

extension CommandSender {
    /// Pending placeholders for a session in send order (oldest
    /// first). Used by `ChatViewModel` to append to the turn list at
    /// render time.
    func pendingInputs(_ sessionId: String) -> [ChatMessage] {
        guard let bucket = outbox[sessionId], !bucket.isEmpty else { return [] }
        // Send order is a local monotonic counter; millisecond timestamps
        // alone tie for rapid sends and dictionary order is undefined.
        return bucket.values.sorted {
            let a = $0.payload["localOrder"]?.intValue ?? 0
            let b = $1.payload["localOrder"]?.intValue ?? 0
            if a != b { return a < b }
            return ($0.timestamp ?? "") < ($1.timestamp ?? "")
        }
    }

    /// A history/range replay is also an authoritative confirmation, even if
    /// its live echo was missed. Match session, message type and client ID;
    /// never clear another queued input or infer confirmation from text.
    func confirmPendingInputs(_ sessionId: String, messages: [ChatMessage]) {
        guard outbox[sessionId]?.isEmpty == false else { return }
        // Some history rows inherit sessionId from their batch envelope.
        for message in messages where (message.sessionId == nil || message.sessionId == sessionId)
            && message.type == "user_message" && message.seq > 0 {
            if let clientId = message.payload["clientId"]?.stringValue {
                clearPending(sessionId, clientId: clientId)
            }
        }
    }
}
