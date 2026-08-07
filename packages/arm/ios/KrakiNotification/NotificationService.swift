import UserNotifications
import Foundation
import Security
import CryptoKit

private enum NotificationBadgeStore {
    static let appGroup = "group.chat.kraki.ios"
    static let unreadSessionIDsKey = "kraki.notification.unreadSessionIDs"

    static func addUnreadSession(_ sessionId: String, to content: UNMutableNotificationContent) {
        let defaults = UserDefaults(suiteName: appGroup)
        var ids = Set(defaults?.stringArray(forKey: unreadSessionIDsKey) ?? [])
        ids.insert(sessionId)
        defaults?.set(ids.sorted(), forKey: unreadSessionIDsKey)
        content.badge = NSNumber(value: max(1, ids.count))
    }
}

// MARK: - SecKey bridging

/// Mirror of `bridgeToSecKey` in the main app target. Kept inline
/// here because the Notification Service Extension is its own
/// target and can't link against the main app's helpers.
///
/// See the comment in `KeychainManager.swift` for why the
/// `CFGetTypeID` check + `as!` is the only correct pattern: Swift's
/// CoreFoundation→Swift `as?` cast is a no-op (compiler warns) and
/// can't be used as a runtime safety net.
private func bridgeToSecKey(_ ref: CFTypeRef) -> SecKey? {
    guard CFGetTypeID(ref) == SecKeyGetTypeID() else { return nil }
    return (ref as! SecKey)
}

/// Notification Service Extension for decrypting Kraki push notification previews.
///
/// APNs payload format from Kraki head:
/// {
///   "aps": { "alert": { "title": "Kraki", "body": "Needs your attention" }, "mutable-content": 1 },
///   "kraki": { "blob": "<base64>", "key": "<base64 RSA-wrapped AES key>" }
/// }
class NotificationService: UNNotificationServiceExtension {

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let content = bestAttemptContent else {
            contentHandler(request.content)
            return
        }
        content.sound = .default

        // Try to decrypt the push preview.
        guard let kraki = request.content.userInfo["kraki"] as? [String: Any],
              let blob = kraki["blob"] as? String,
              let key = kraki["key"] as? String else {
            if let sessionId = request.content.userInfo["sessionId"] as? String {
                applySessionPresentation(sessionId, to: content)
            }
            contentHandler(content)
            return
        }

        do {
            let decrypted = try decryptPreview(blob: blob, wrappedKey: key)
            let preview = parsePreview(decrypted)
            content.title = preview.title
            content.subtitle = preview.subtitle
            content.body = preview.body
            if let sessionId = preview.sessionId {
                content.userInfo["sessionId"] = sessionId
                applySessionPresentation(sessionId, to: content)
            }
        } catch {
            // Decryption failed: retain a useful, private fallback. The raw APNs
            // payload already carries the default sound and attention badge.
            content.title = "Kraki"
            content.subtitle = "New activity"
            content.body = "Open Kraki to view the update."
        }

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            content.title = "Kraki"
            content.subtitle = "New activity"
            content.body = "Open Kraki to view the update."
            content.sound = .default
            contentHandler(content)
        }
    }

    private func applySessionPresentation(
        _ sessionId: String,
        to content: UNMutableNotificationContent
    ) {
        content.threadIdentifier = sessionId
        NotificationBadgeStore.addUnreadSession(sessionId, to: content)
    }

    // MARK: - Crypto

    private func decryptPreview(blob: String, wrappedKey: String) throws -> String {
        // Load encryption private key from shared keychain
        guard let privateKey = loadEncryptionKey() else {
            throw NSError(domain: "KrakiNotification", code: 1, userInfo: [NSLocalizedDescriptionKey: "No encryption key"])
        }

        // Unwrap AES key with RSA-OAEP
        guard let wrappedKeyData = Data(base64Encoded: wrappedKey) else {
            throw NSError(domain: "KrakiNotification", code: 3, userInfo: [NSLocalizedDescriptionKey: "Invalid key base64"])
        }

        var error: Unmanaged<CFError>?
        guard let aesKeyData = SecKeyCreateDecryptedData(
            privateKey,
            .rsaEncryptionOAEPSHA256,
            wrappedKeyData as CFData,
            &error
        ) as Data? else {
            throw NSError(domain: "KrakiNotification", code: 4, userInfo: [NSLocalizedDescriptionKey: "Key unwrap failed"])
        }

        // Parse blob: iv[0..12] + ciphertext[12..n-16] + tag[n-16..n]
        guard let blobData = Data(base64Encoded: blob), blobData.count > 28 else {
            throw NSError(domain: "KrakiNotification", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid blob"])
        }

        let iv = blobData[0..<12]
        let ciphertext = blobData[12..<(blobData.count - 16)]
        let tag = blobData[(blobData.count - 16)...]

        let symmetricKey = SymmetricKey(data: aesKeyData)
        let nonce = try AES.GCM.Nonce(data: iv)
        let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        let plainData = try AES.GCM.open(sealedBox, using: symmetricKey)

        guard let plaintext = String(data: plainData, encoding: .utf8) else {
            throw NSError(domain: "KrakiNotification", code: 6, userInfo: [NSLocalizedDescriptionKey: "Invalid UTF-8"])
        }

        return plaintext
    }

    private func loadEncryptionKey() -> SecKey? {
        let tag = "chat.kraki.ios.encryption-key"
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecReturnRef as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let ref = result else { return nil }
        // Bridge through the centralised helper — no inline `as!`
        // here. Corrupt entries / simulator edge cases just drop
        // the encrypted preview and iOS falls back to the default
        // "New message" copy.
        return bridgeToSecKey(ref)
    }

    // MARK: - Preview Parsing

    private struct Preview {
        let title: String
        let subtitle: String
        let body: String
        let sessionId: String?
    }

    private func parsePreview(_ json: String) -> Preview {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return Preview(
                title: "Kraki",
                subtitle: "New activity",
                body: "Open Kraki to view the update.",
                sessionId: nil
            )
        }

        // Tentacle's encrypted preview payload. The app name is already shown by
        // iOS, so use the Session title as the notification title and reserve the
        // subtitle for the kind of attention required.
        let messageType = obj["type"] as? String
        let sessionId = obj["sessionId"] as? String
        let sessionTitle = normalized(obj["title"] as? String)
        let summary = normalized(obj["summary"] as? String)

        let subtitle: String
        let fallbackBody: String
        switch messageType {
        case "permission":
            subtitle = "Approval needed"
            fallbackBody = "Review the requested tool action."
        case "question":
            subtitle = "Question from agent"
            fallbackBody = "Open the Session to respond."
        case "idle":
            subtitle = "Reply ready"
            fallbackBody = "The agent finished responding."
        case "error":
            subtitle = "Action failed"
            fallbackBody = "Open the Session for details."
        case "session_ended":
            subtitle = "Session ended"
            fallbackBody = "The Session is no longer running."
        default:
            subtitle = "New activity"
            fallbackBody = "Open Kraki to view the update."
        }

        return Preview(
            title: sessionTitle ?? "Kraki",
            subtitle: subtitle,
            body: summary ?? fallbackBody,
            sessionId: sessionId
        )
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let text = value
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return text.isEmpty ? nil : text
    }
}
