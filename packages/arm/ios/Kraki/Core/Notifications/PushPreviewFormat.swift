import Foundation

/// Turns the Tentacle's decrypted push preview into notification text.
/// Shared by the iOS Notification Service Extension and the macOS app so both
/// platforms read the same way (layout agreed 2026-10-02):
/// - title: the Session name, like a chat app uses the contact name. The app
///   icon already says Kraki, so the app name is not repeated.
/// - no subtitle.
/// - body: the reply itself; when the human must act a short label leads the
///   body ("Needs approval: …", "Question: …", "Failed: …").
/// - category: selects the locked-screen placeholder on iOS.
enum PushPreviewFormat {
    struct Content: Equatable {
        let title: String
        let body: String
        let category: String
        let sessionId: String?
    }

    static let fallbackTitle = "Kraki"
    static let fallbackBody = "Open Kraki to view the update."

    /// Category id → body shown while previews are hidden (locked iPhone).
    static let lockedPlaceholders: [(category: String, placeholder: String)] = [
        ("kraki.reply", "New reply"),
        ("kraki.permission", "Needs your approval"),
        ("kraki.question", "Has a question for you"),
        ("kraki.failed", "A turn failed"),
    ]

    static func content(fromJSON json: String) -> Content {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return Content(title: fallbackTitle, body: fallbackBody, category: "", sessionId: nil)
        }
        let summary = normalized(obj["summary"] as? String)
        let steps = obj["steps"] as? Int ?? 0

        let body: String
        let category: String
        switch obj["type"] as? String {
        case "permission":
            body = "Needs approval: " + (summary ?? "Review the requested action.")
            category = "kraki.permission"
        case "question":
            body = "Question: " + (summary ?? "Open the Session to respond.")
            category = "kraki.question"
        case "error":
            body = "Failed: " + (summary ?? "The turn did not finish.")
            category = "kraki.failed"
        case "idle":
            if let summary {
                body = summary
            } else if steps > 0 {
                body = "Finished with \(steps) step\(steps == 1 ? "" : "s") and no reply."
            } else {
                body = "Finished with no reply."
            }
            category = "kraki.reply"
        default:
            body = summary ?? fallbackBody
            category = ""
        }
        return Content(
            title: normalized(obj["title"] as? String) ?? fallbackTitle,
            body: body,
            category: category,
            sessionId: obj["sessionId"] as? String
        )
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let text = value
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return text.isEmpty ? nil : text
    }
}
