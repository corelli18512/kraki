import CoinfraCrypto
import CryptoKit
import Foundation

/// E2E v2: the `@coinfra/crypto` suite v1 (X25519 + HKDF-SHA256 +
/// AES-256-GCM) carried in a Pulse payload as `{"v": 2, "blob": <envelope>}`.
/// The legacy RSA payload is `{blob, keys}`; both are always accepted.
///
/// Peer keys travel in the existing handshake, not through the Head: a
/// Tentacle announces `e2eKeys.x25519` in its greeting (and `e2e_v2` in
/// `features` when it accepts v2), and this app announces its own key and
/// `e2e_v2` in `client_features`. The app sends v2 only to a Tentacle that
/// advertised both; everything else stays RSA.
enum E2EV2 {
    static let feature = "e2e_v2"

    static func isPayload(_ json: [String: Any]) -> Bool {
        (json["v"] as? Int) == 2 && json["blob"] is String
    }

    static func publicKey(_ key: Curve25519.KeyAgreement.PrivateKey) -> String {
        CoinfraCrypto.base64url(key.publicKey.rawRepresentation)
    }

    /// Envelope for `recipients` (deviceId → base64url X25519 public key).
    static func encrypt(_ plaintext: String, recipients: [(deviceId: String, publicKey: String)]) throws -> String {
        try CoinfraCrypto.encryptToBlob(
            plaintext,
            recipients: recipients.map { .init(recipientId: $0.deviceId, publicKey: $0.publicKey) }
        )
    }

    /// Nil when the envelope has no entry for `deviceId` (not addressed to us).
    static func decrypt(
        _ blob: String,
        deviceId: String,
        privateKey: Curve25519.KeyAgreement.PrivateKey
    ) throws -> String? {
        do {
            return try CoinfraCrypto.decryptFromBlob(blob, recipientId: deviceId, privateKey: privateKey)
        } catch CoinfraCryptoError.noKeyForRecipient {
            return nil
        }
    }
}
