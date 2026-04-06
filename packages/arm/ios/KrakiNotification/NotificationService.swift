import UserNotifications
import Foundation
import Security
import CryptoKit

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

        // Try to decrypt the push preview
        guard let kraki = request.content.userInfo["kraki"] as? [String: Any],
              let blob = kraki["blob"] as? String,
              let key = kraki["key"] as? String else {
            // No encrypted preview — use default aps.alert
            contentHandler(content)
            return
        }

        do {
            let decrypted = try decryptPreview(blob: blob, wrappedKey: key)
            let preview = parsePreview(decrypted)
            content.title = preview.title
            content.body = preview.body
            if let sessionId = preview.sessionId {
                content.userInfo["sessionId"] = sessionId
            }
        } catch {
            // Decryption failed — show generic notification
            content.title = "Kraki"
            content.body = "Needs your attention"
        }

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            content.title = "Kraki"
            content.body = "Needs your attention"
            contentHandler(content)
        }
    }

    // MARK: - Crypto

    private func decryptPreview(blob: String, wrappedKey: String) throws -> String {
        // Load encryption private key from shared keychain
        guard let privateKey = loadEncryptionKey() else {
            throw NSError(domain: "KrakiNotification", code: 1, userInfo: [NSLocalizedDescriptionKey: "No encryption key"])
        }

        guard let deviceId = loadDeviceId() else {
            throw NSError(domain: "KrakiNotification", code: 2, userInfo: [NSLocalizedDescriptionKey: "No device ID"])
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
        let tag = "cloud.corelli.kraki.encryption-key"
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecReturnRef as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return (result as! SecKey)
    }

    private func loadDeviceId() -> String? {
        UserDefaults(suiteName: "group.cloud.corelli.kraki")?.string(forKey: "deviceId")
    }

    // MARK: - Preview Parsing

    private struct Preview {
        let title: String
        let body: String
        let sessionId: String?
    }

    private func parsePreview(_ json: String) -> Preview {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return Preview(title: "Kraki", body: "New message", sessionId: nil)
        }

        let messageType = obj["type"] as? String
        let sessionId = obj["sessionId"] as? String

        let body: String
        switch messageType {
        case "permission":
            let desc = obj["description"] as? String ?? "Tool approval needed"
            body = "🔐 \(desc)"
        case "question":
            let question = obj["question"] as? String ?? "Question from agent"
            body = "❓ \(question)"
        case "agent_message":
            let content = obj["content"] as? String ?? ""
            body = String(content.prefix(200))
        case "error":
            let message = obj["message"] as? String ?? "Error occurred"
            body = "⚠️ \(message)"
        case "session_ended":
            body = "Session ended"
        default:
            body = "Activity in session"
        }

        let title: String
        if let sessionTitle = obj["title"] as? String {
            title = "Kraki — \(sessionTitle)"
        } else {
            title = "Kraki"
        }

        return Preview(title: title, body: body, sessionId: sessionId)
    }
}
