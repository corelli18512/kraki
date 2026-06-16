import UserNotifications
import Foundation
import Security
import CryptoKit

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
        let body: String
        let sessionId: String?
    }

    private func parsePreview(_ json: String) -> Preview {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return Preview(title: "Kraki", body: "New message", sessionId: nil)
        }

        // Tentacle's pushPreview payload shape (see relay-client.ts):
        //   { type: "permission" | "question" | "idle", summary, sessionId }
        let messageType = obj["type"] as? String
        let sessionId = obj["sessionId"] as? String
        let summary = obj["summary"] as? String

        let body: String
        switch messageType {
        case "permission":
            body = "🔐 " + (summary ?? "Tool approval needed")
        case "question":
            body = "❓ " + (summary ?? "Question from agent")
        case "idle":
            // Idle pushes carry the last agent message as `summary`
            body = summary ?? "Agent finished"
        case "error":
            body = "⚠️ " + (summary ?? "Error occurred")
        case "session_ended":
            body = "Session ended"
        default:
            body = summary ?? "Needs your attention"
        }

        // The tentacle doesn't currently include a session title in the preview,
        // so fall back to just the brand name.
        let title = (obj["title"] as? String).map { "Kraki — \($0)" } ?? "Kraki"

        return Preview(title: title, body: body, sessionId: sessionId)
    }
}
