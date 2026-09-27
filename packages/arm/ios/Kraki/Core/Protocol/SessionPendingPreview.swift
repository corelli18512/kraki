import Foundation

/// A local delivery overlay, not a new server SessionState. A pending input's
/// text and icon always move together; clearing it reveals the live projection.
enum SessionDeliveryStatus: Equatable {
    case correcting, sending, failed, queued

    var accessibilityLabel: String {
        switch self {
        case .correcting: return "Correcting voice message before sending"
        case .sending: return "Sending, awaiting confirmation"
        case .failed: return "Send failed or not confirmed"
        case .queued: return "Waiting for connection"
        }
    }
}

struct SessionPendingPreview: Equatable {
    let clientId: String
    let text: String
    let timestamp: String
    let status: SessionDeliveryStatus

    static func select(_ inputs: [ChatMessage], sessionId: String, isOnline: Bool) -> Self? {
        // Errors must not disappear behind a newer pending send or fresh draft.
        // Within a priority, use local send order, then deterministic tie breaks.
        let candidates = inputs.filter { $0.sessionId == sessionId && $0.type == "pending_input" }
        let message = candidates.max { a, b in
            let aFailed = state(a) == .failed, bFailed = state(b) == .failed
            if aFailed != bFailed { return !aFailed }
            let aOrder = a.payload["localOrder"]?.intValue ?? 0
            let bOrder = b.payload["localOrder"]?.intValue ?? 0
            if aOrder != bOrder { return aOrder < bOrder }
            if a.timestamp != b.timestamp { return (a.timestamp ?? "") < (b.timestamp ?? "") }
            return (a.payload["clientId"]?.stringValue ?? "") < (b.payload["clientId"]?.stringValue ?? "")
        }
        guard let message else { return nil }
        let status: SessionDeliveryStatus
        switch state(message) {
        case .correcting: status = .correcting // local correction is not transport
        case .failed: status = .failed
        case .sending: status = isOnline ? .sending : .queued
        }
        let content = message.content?.collapseWhitespace() ?? ""
        let fallback = message.payload["attachments"] != nil ? "[image]" : "…"
        let prefix: String
        switch status {
        case .failed: prefix = "Send failed · "
        case .queued: prefix = "Waiting for connection · "
        default: prefix = ""
        }
        return Self(clientId: message.payload["clientId"]?.stringValue ?? "",
                    text: prefix + (content.isEmpty ? fallback : content),
                    timestamp: message.timestamp ?? "", status: status)
    }

    private static func state(_ message: ChatMessage) -> CommandSender.PendingState {
        message.payload["localState"]?.stringValue.flatMap(CommandSender.PendingState.init(rawValue:)) ?? .sending
    }
}
