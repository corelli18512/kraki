/// Which text of an outbox entry survives a relaunch.

import Foundation

extension CommandSender {
    /// A still-correcting voice input restores as failed with its original
    /// transcript, never a half-corrected one. Once dispatched (or failed) the
    /// entry restores with exactly the text it was sent with, so an automatic
    /// resend under the same clientId repeats the corrected text.
    static func durableText(_ message: ChatMessage, wire: [String: Any]?) -> String {
        if message.payload["localState"]?.stringValue == PendingState.correcting.rawValue,
           let original = message.payload["originalText"]?.stringValue {
            return original
        }
        return wire?["text"] as? String ?? message.content ?? ""
    }
}
