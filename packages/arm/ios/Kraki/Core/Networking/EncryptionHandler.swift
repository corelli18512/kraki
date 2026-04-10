/// EncryptionHandler — End-to-end encryption for inbound and outbound messages.
///
/// Mirrors `encryption.ts`:
/// - Encrypts outbound messages as unicast (single target device) or broadcast
///   (all known tentacle devices) envelopes.
/// - Decrypts inbound unicast / broadcast envelopes addressed to this device.
/// - Queues encrypted messages that arrive before the keystore is ready and
///   drains the queue once auth completes.

import Foundation

// MARK: - EncryptionError

enum EncryptionError: Error, CustomStringConvertible {
    case notReady
    case encodingFailed
    case decodingFailed
    case noTargetDevice
    case noTargetKey
    case noRecipients
    case invalidEnvelope
    case notAddressedToUs

    var description: String {
        switch self {
        case .notReady:         return "Encryption handler not ready (missing deviceId or keys)"
        case .encodingFailed:   return "Failed to encode message to UTF-8"
        case .decodingFailed:   return "Failed to decode decrypted payload"
        case .noTargetDevice:   return "No target device resolved for unicast"
        case .noTargetKey:      return "Target device has no encryption key"
        case .noRecipients:     return "No recipient devices available for broadcast"
        case .invalidEnvelope:  return "Encrypted envelope is malformed"
        case .notAddressedToUs: return "Envelope does not contain a key for this device"
        }
    }
}

// MARK: - EncryptionHandler

final class EncryptionHandler {

    // MARK: Dependencies

    private let crypto: CryptoManager
    private let keychain: KeychainManager
    private weak var appState: AppState?

    // MARK: Queue

    /// Encrypted envelopes received before we had a deviceId / ready keystore.
    private var encryptedQueue: [Data] = []

    /// Called for each successfully decrypted message during `drainQueue()`.
    var onDecrypted: ((Data) -> Void)?

    // MARK: Init

    init(crypto: CryptoManager, keychain: KeychainManager, appState: AppState) {
        self.crypto = crypto
        self.keychain = keychain
        self.appState = appState
    }

    // MARK: - Ready check

    /// The handler is ready when we have a confirmed deviceId and both key
    /// pairs are present in the Keychain.
    var isReady: Bool {
        appState?.deviceId != nil && keychain.hasKeys()
    }

    // MARK: - Outbound Encryption

    /// Encrypt a message for sending.
    ///
    /// - If a `sessionId` is provided the handler resolves the owning device
    ///   and produces a **unicast** envelope.
    /// - If `sessionId` is `nil` the handler encrypts for every known device
    ///   (excluding self) and produces a **broadcast** envelope.
    ///
    /// - Returns: The JSON-serialised envelope ready to send, and a flag
    ///   indicating whether it is unicast.
    func encryptOutbound<T: Encodable>(
        _ message: T,
        sessionId: String?
    ) throws -> (data: Data, isUnicast: Bool) {
        guard let appState else { throw EncryptionError.notReady }

        let messageData = try JSONEncoder().encode(message)
        guard let plaintext = String(data: messageData, encoding: .utf8) else {
            throw EncryptionError.encodingFailed
        }

        // --- Determine target ---

        var targetDeviceId: String?
        if let sessionId {
            targetDeviceId = appState.sessionStore.session(for: sessionId)?.deviceId
        }

        if let targetDeviceId {
            return try encryptUnicast(
                plaintext: plaintext,
                targetDeviceId: targetDeviceId,
                messageData: messageData
            )
        } else {
            return try encryptBroadcast(plaintext: plaintext)
        }
    }

    // MARK: Unicast

    private func encryptUnicast(
        plaintext: String,
        targetDeviceId: String,
        messageData: Data
    ) throws -> (data: Data, isUnicast: Bool) {
        guard let appState else { throw EncryptionError.notReady }

        guard let targetDevice = appState.deviceStore.device(for: targetDeviceId),
              let keyBase64 = targetDevice.encryptionKey ?? targetDevice.publicKey else {
            throw EncryptionError.noTargetKey
        }

        let recipientKey = try crypto.importPublicKeyFromSPKI(keyBase64)
        let recipient = RecipientKey(deviceId: targetDeviceId, publicKey: recipientKey)
        let payload = try crypto.encryptToBlob(plaintext, recipients: [recipient])

        var envelope: [String: Any] = [
            "type": "unicast",
            "to": targetDeviceId,
            "blob": payload.blob,
            "keys": payload.keys,
        ]

        // Propagate requestId as `ref` so the relay can echo it in server_error
        if let dict = try? JSONSerialization.jsonObject(with: messageData) as? [String: Any],
           dict["type"] as? String == "create_session",
           let inner = dict["payload"] as? [String: Any],
           let requestId = inner["requestId"] as? String {
            envelope["ref"] = requestId
        }

        let envelopeData = try JSONSerialization.data(withJSONObject: envelope)
        return (data: envelopeData, isUnicast: true)
    }

    // MARK: Broadcast

    private func encryptBroadcast(
        plaintext: String
    ) throws -> (data: Data, isUnicast: Bool) {
        guard let appState else { throw EncryptionError.notReady }

        let ownDeviceId = appState.deviceId ?? ""
        let allDevices = appState.deviceStore.allDevices()
        var recipients: [RecipientKey] = []

        for device in allDevices {
            guard device.id != ownDeviceId,
                  let keyBase64 = device.encryptionKey ?? device.publicKey else { continue }
            if let pubKey = try? crypto.importPublicKeyFromSPKI(keyBase64) {
                recipients.append(RecipientKey(deviceId: device.id, publicKey: pubKey))
            }
        }

        guard !recipients.isEmpty else {
            throw EncryptionError.noRecipients
        }

        let payload = try crypto.encryptToBlob(plaintext, recipients: recipients)
        let envelope: [String: Any] = [
            "type": "broadcast",
            "blob": payload.blob,
            "keys": payload.keys,
        ]
        let envelopeData = try JSONSerialization.data(withJSONObject: envelope)
        return (data: envelopeData, isUnicast: false)
    }

    // MARK: - Inbound Decryption

    /// Decrypt an incoming unicast or broadcast envelope.
    ///
    /// - Returns: The inner plaintext JSON and the `sessionId` extracted from it
    ///   (if present).
    func decryptInbound(_ envelope: Data) throws -> (message: Data, sessionId: String?) {
        guard let appState, let deviceId = appState.deviceId else {
            KLog.d("❌ decrypt: not ready (deviceId: \(appState?.deviceId ?? "nil"))")
            throw EncryptionError.notReady
        }

        guard let json = try JSONSerialization.jsonObject(with: envelope) as? [String: Any],
              let blob = json["blob"] as? String,
              let keys = json["keys"] as? [String: String] else {
            KLog.d("❌ decrypt: invalid envelope structure")
            throw EncryptionError.invalidEnvelope
        }

        KLog.d("🔐 Envelope keys: [\(keys.keys.map { String($0.prefix(12)) }.joined(separator: ", "))] — our deviceId: \(deviceId.prefix(12))...")

        guard keys[deviceId] != nil else {
            KLog.d("📭 Not addressed to us")
            throw EncryptionError.notAddressedToUs
        }

        let cryptoPayload = CryptoBlobPayload(blob: blob, keys: keys)
        let encryptionKey = try keychain.getOrCreateEncryptionKey()
        let plaintext = try crypto.decryptFromBlob(
            cryptoPayload,
            deviceId: deviceId,
            privateKey: encryptionKey.privateKey
        )

        KLog.d("🔓 Decrypted: \(String(plaintext.prefix(100)))")

        guard let messageData = plaintext.data(using: .utf8) else {
            throw EncryptionError.decodingFailed
        }

        let innerJson = try? JSONSerialization.jsonObject(with: messageData) as? [String: Any]
        let sessionId = innerJson?["sessionId"] as? String

        return (message: messageData, sessionId: sessionId)
    }

    // MARK: - Queue Management

    /// Stash an encrypted envelope for later processing (before auth completes).
    func enqueue(_ envelope: Data) {
        encryptedQueue.append(envelope)
    }

    /// Decrypt all queued envelopes and deliver them via `onDecrypted`.
    /// Called by `MessageRouter.drainQueue()` after auth succeeds.
    func drainQueue() {
        KLog.d("🔄 Drain queue: \(encryptedQueue.count) items, ready: \(isReady)")
        guard isReady, !encryptedQueue.isEmpty else { return }

        let queued = encryptedQueue
        encryptedQueue = []

        for envelope in queued {
            do {
                let result = try decryptInbound(envelope)
                onDecrypted?(result.message)
            } catch {
                KLog.d("❌ Queued decrypt failed: \(error)")
            }
        }
    }
}
