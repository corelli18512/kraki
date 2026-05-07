/// KeychainManager — Secure RSA key storage using iOS Keychain.
///
/// Stores two RSA-4096 key pairs:
/// - Signing key (RSASSA-PKCS1-v1_5) for challenge-response auth
/// - Encryption key (RSA-OAEP) for E2E message decryption
///
/// Uses `kSecAttrAccessibleAfterFirstUnlock` so the Notification Service Extension
/// can access keys in the background without requiring device unlock.
///
/// Sharing with the NSE: when `accessGroup` is nil (default), iOS uses the FIRST
/// entry in the `keychain-access-groups` entitlement. Both the host app and
/// `KrakiNotification` declare `$(AppIdentifierPrefix)cloud.corelli.kraki`, so
/// keys are placed in that shared group automatically — the NSE can read them
/// without specifying the group either.
///
/// Note: keys that were stored BEFORE the entitlement was added live in the
/// app's default (private) group and are NOT visible to the NSE. Call
/// `deleteAllKeys()` once after enabling the entitlement to migrate; new keys
/// will be generated in the shared group on next access.

import Foundation
import Security

// MARK: - Errors

public enum KeychainError: Error, CustomStringConvertible {
    case saveFailed(OSStatus)
    case loadFailed(OSStatus)
    case deleteFailed(OSStatus)
    case unexpectedData
    case keyGenerationFailed(String)

    public var description: String {
        switch self {
        case .saveFailed(let s):          return "Keychain save failed: \(s)"
        case .loadFailed(let s):          return "Keychain load failed: \(s)"
        case .deleteFailed(let s):        return "Keychain delete failed: \(s)"
        case .unexpectedData:             return "Unexpected keychain data format"
        case .keyGenerationFailed(let m): return "Key generation failed: \(m)"
        }
    }
}

// MARK: - KeychainManager

public final class KeychainManager {

    private static let signingKeyTag    = "cloud.corelli.kraki.signing-key"
    private static let encryptionKeyTag = "cloud.corelli.kraki.encryption-key"

    /// Optional app group for shared keychain access (app ↔ notification extension).
    private let accessGroup: String?

    public init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    // MARK: - Public API

    /// Load or generate the signing key pair (for challenge-response auth).
    public func getOrCreateSigningKey() throws -> (privateKey: SecKey, publicKey: SecKey) {
        if let existing = try loadKeyPair(tag: Self.signingKeyTag) {
            return existing
        }
        return try generateAndStoreKeyPair(tag: Self.signingKeyTag)
    }

    /// Load or generate the encryption key pair (for E2E message decryption).
    public func getOrCreateEncryptionKey() throws -> (privateKey: SecKey, publicKey: SecKey) {
        if let existing = try loadKeyPair(tag: Self.encryptionKeyTag) {
            return existing
        }
        return try generateAndStoreKeyPair(tag: Self.encryptionKeyTag)
    }

    /// Check if both key pairs exist without generating them.
    public func hasKeys() -> Bool {
        return (try? loadKeyPair(tag: Self.signingKeyTag)) != nil &&
               (try? loadKeyPair(tag: Self.encryptionKeyTag)) != nil
    }

    /// Delete all stored keys (for account reset or testing).
    public func deleteAllKeys() throws {
        try deleteKeyPair(tag: Self.signingKeyTag)
        try deleteKeyPair(tag: Self.encryptionKeyTag)
    }

    // MARK: - Key Storage

    private func generateAndStoreKeyPair(tag: String) throws -> (privateKey: SecKey, publicKey: SecKey) {
        var privateKeyAttrs: [String: Any] = [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        if let group = accessGroup {
            privateKeyAttrs[kSecAttrAccessGroup as String] = group
        }

        var attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits as String: 4096,
            kSecPrivateKeyAttrs as String: privateKeyAttrs,
        ]

        if let group = accessGroup {
            attrs[kSecAttrAccessGroup as String] = group
        }

        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
            throw KeychainError.keyGenerationFailed(
                error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
            )
        }

        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw KeychainError.keyGenerationFailed("Cannot extract public key")
        }

        return (privateKey: privateKey, publicKey: publicKey)
    }

    private func loadKeyPair(tag: String) throws -> (privateKey: SecKey, publicKey: SecKey)? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecReturnRef as String: true,
        ]

        if let group = accessGroup {
            query[kSecAttrAccessGroup as String] = group
        }

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let ref = result else {
            throw KeychainError.loadFailed(status)
        }

        // swiftlint:disable:next force_cast
        let privateKey = ref as! SecKey
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw KeychainError.unexpectedData
        }

        return (privateKey: privateKey, publicKey: publicKey)
    }

    private func deleteKeyPair(tag: String) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
        ]

        if let group = accessGroup {
            query[kSecAttrAccessGroup as String] = group
        }

        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw KeychainError.deleteFailed(status)
        }
    }
}
