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
    case senderMismatch
    case staleRoute
    case untrusted(String)

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
        case .senderMismatch:   return "Message deviceId does not match the relay-stamped sender"
        case .staleRoute:       return "Connection-scoped message arrived on a replaced route"
        case .untrusted(let r): return "Rejected by device trust: \(r)"
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

    /// Called for each successfully decrypted message. Delivery is marshalled
    /// back to the main actor by MessageRouter, while RSA/Keychain work stays on
    /// this strictly ordered background queue.
    var onDecrypted: ((Data) -> Void)?

    private let decryptQueue = DispatchQueue(
        label: "chat.kraki.inbound-decrypt",
        qos: .userInitiated
    )
    private let keyStateLock = NSLock()
    /// Drops exact repeats of signed computer messages (DeviceTrust.swift).
    private let replayGuard = DeviceTrustReplayGuard()
    private var keyAvailabilityConfirmed = false
    private var cachedEncryptionKeyPair: (privateKey: SecKey, publicKey: SecKey)?

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
        guard appState?.deviceId != nil else { return false }
        keyStateLock.lock()
        let confirmed = keyAvailabilityConfirmed
        keyStateLock.unlock()
        if confirmed { return true }
        let available = keychain.hasKeys()
        if available {
            keyStateLock.lock()
            keyAvailabilityConfirmed = true
            keyStateLock.unlock()
        }
        return available
    }

    // MARK: - Inbound Decryption

    /// Decrypt an incoming unicast or broadcast envelope.
    ///
    /// - Returns: The inner plaintext JSON and the `sessionId` extracted from it
    ///   (if present).
    static let staleRouteKey = "krakiStaleRoute"
    static let connectionScopedTypes: Set<String> = [
        "agent_message_delta", "card_action", "session_subscription_set",
    ]

    func submitForDecryption(_ envelope: Data) {
        decryptQueue.async { [weak self] in
            guard let self else { return }
            guard self.isReady else {
                self.encryptedQueue.append(envelope)
                return
            }
            self.decryptAndDeliver(envelope)
        }
    }

    private func decryptAndDeliver(_ envelope: Data) {
        do {
            let result = try decryptInbound(envelope)
            onDecrypted?(result.message)
        } catch EncryptionError.staleRoute {
            return
        } catch EncryptionError.notAddressedToUs {
            KLog.d("📭 Envelope not addressed to us — skipping")
        } catch {
            KLog.d("❌ Decryption failed: \(error)")
        }
    }

    func decryptInbound(_ envelope: Data) throws -> (message: Data, sessionId: String?) {
        guard let appState, let deviceId = appState.deviceId else {
            KLog.d("❌ decrypt: not ready (deviceId: \(appState?.deviceId ?? "nil"))")
            throw EncryptionError.notReady
        }

        guard let json = try JSONSerialization.jsonObject(with: envelope) as? [String: Any] else {
            KLog.d("❌ decrypt: invalid envelope structure")
            throw EncryptionError.invalidEnvelope
        }
        // Device trust: X25519 payload from a paired computer.
        if E2EV2.isPayload(json), let blob = json["blob"] as? String {
            guard let plaintext = try E2EV2.decrypt(blob, deviceId: deviceId,
                                                    privateKey: DeviceIdentityKeys.shared.agreementKey()) else {
                throw EncryptionError.notAddressedToUs
            }
            return try authenticate(plaintext, envelope: json, deviceId: deviceId)
        }
        guard let blob = json["blob"] as? String,
              let keys = json["keys"] as? [String: String] else {
            KLog.d("❌ decrypt: invalid envelope structure")
            throw EncryptionError.invalidEnvelope
        }

        // Compact envelope-key log: just the count + whether we're in
        // the recipient set. Full key dump is huge (28-device sessions
        // emit ~500B per broadcast) and during agent-reply streaming
        // these fire 20+/sec — string allocation + I/O dominates CPU.
        // Re-enable the full dump via the `KRAKI_LOG_OS_LOG=1` env var
        // path in KrakiLogger if needed.
        let weAreIn = keys[deviceId] != nil ? "✓" : "✗"
        KLog.d("🔐 Envelope keys=\(keys.count) us=\(weAreIn)")

        guard keys[deviceId] != nil else {
            KLog.d("📭 Not addressed to us")
            throw EncryptionError.notAddressedToUs
        }

        let plaintext = try decryptLegacy(blob: blob, keys: keys, deviceId: deviceId)
        return try authenticate(plaintext, envelope: json, deviceId: deviceId)
    }

    /// RSA (legacy) decryption only — no sender or trust checks. Callers must
    /// treat the result as unauthenticated (see notification previews).
    func decryptUnauthenticated(blob: String, key: String) -> String? {
        guard let deviceId = appState?.deviceId else { return nil }
        return try? decryptLegacy(blob: blob, keys: [deviceId: key], deviceId: deviceId)
    }

    private func decryptLegacy(blob: String, keys: [String: String], deviceId: String) throws -> String {
        let cryptoPayload = CryptoBlobPayload(blob: blob, keys: keys)
        let encryptionKey: (privateKey: SecKey, publicKey: SecKey)
        keyStateLock.lock()
        let cached = cachedEncryptionKeyPair
        keyStateLock.unlock()
        if let cached {
            encryptionKey = cached
        } else {
            let loaded = try keychain.getOrCreateEncryptionKey()
            keyStateLock.lock()
            cachedEncryptionKeyPair = loaded
            keyAvailabilityConfirmed = true
            keyStateLock.unlock()
            encryptionKey = loaded
        }
        let plaintext = try crypto.decryptFromBlob(
            cryptoPayload,
            deviceId: deviceId,
            privateKey: encryptionKey.privateKey
        )
        KLog.d("🔓 Decrypted: \(String(plaintext.prefix(100)))")
        return plaintext
    }

    /// Signature/attribution checks (DeviceTrust.swift), then the existing
    /// sender-stamp and stale-route checks.
    private func authenticate(_ plaintext: String, envelope json: [String: Any], deviceId: String) throws -> (message: Data, sessionId: String?) {
        let messageData: Data
        switch DeviceTrustInbound.check(plaintext: plaintext, src: json["src"] as? String, selfId: deviceId,
                                         replayGuard: replayGuard) {
        case .message(let data):
            messageData = data
        case .rejected(let reason):
            KLog.d("⛔️ device trust: rejected payload (\(reason)) src=\(json["src"] as? String ?? "-")")
            if reason.hasPrefix("unsigned_from_pinned:") {
                let id = String(reason.dropFirst("unsigned_from_pinned:".count))
                DispatchQueue.main.async { [weak appState] in appState?.noteUnsignedFromPinned(id) }
            }
            throw EncryptionError.untrusted(reason)
        }

        let innerJson = try? JSONSerialization.jsonObject(with: messageData) as? [String: Any]
        // The head stamps the authenticated sender (`src`) on forwarded Pulse
        // payloads. The deviceId inside the ciphertext is chosen by the sender,
        // so a mismatch means one device is posing as another.
        if let sender = json["src"] as? String,
           let claimed = innerJson?["deviceId"] as? String,
           !claimed.isEmpty, claimed != sender {
            KLog.d("⚠️ Dropped message whose deviceId does not match its sender")
            throw EncryptionError.senderMismatch
        }
        // Delivered by a route that has since been replaced (a Head frame from
        // the Tentacle this Mac is now linked to). Connection-scoped live state
        // from it would land after the new route's snapshot; drop just those.
        if json[Self.staleRouteKey] as? Bool == true,
           let type = innerJson?["type"] as? String,
           Self.connectionScopedTypes.contains(type) {
            KLog.d("🔗 Dropped stale-route \(type)")
            throw EncryptionError.staleRoute
        }
        let sessionId = innerJson?["sessionId"] as? String

        return (message: messageData, sessionId: sessionId)
    }

    // MARK: - Queue Management

    /// Stash an encrypted envelope for later processing (before auth completes).
    func enqueue(_ envelope: Data) {
        decryptQueue.async { [weak self] in
            self?.encryptedQueue.append(envelope)
        }
    }

    /// Decrypt all queued envelopes and deliver them via `onDecrypted`.
    /// Called by `MessageRouter.drainQueue()` after auth succeeds.
    func drainQueue() {
        decryptQueue.async { [weak self] in
            guard let self else { return }
            KLog.d("🔄 Drain queue: \(self.encryptedQueue.count) items, ready: \(self.isReady)")
            guard self.isReady, !self.encryptedQueue.isEmpty else { return }

            let queued = self.encryptedQueue
            self.encryptedQueue = []
            for envelope in queued {
                self.decryptAndDeliver(envelope)
            }
        }
    }
}
