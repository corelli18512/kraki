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
/// `KrakiNotification` declare `$(AppIdentifierPrefix)chat.kraki.ios`, so
/// keys are placed in that shared group automatically — the NSE can read them
/// without specifying the group either.
///
/// Note: keys that were stored BEFORE the entitlement was added live in the
/// app's default (private) group and are NOT visible to the NSE. Call
/// `deleteAllKeys()` once after enabling the entitlement to migrate; new keys
/// will be generated in the shared group on next access.

import Foundation
import Security

// MARK: - SecKey bridging

/// Bridge a `CFTypeRef` returned from Keychain APIs to a Swift
/// `SecKey`, but only after a runtime CoreFoundation type ID check.
///
/// Swift's `as?` cast for CoreFoundation types is a no-op (the
/// compiler explicitly warns about it: "conditional downcast to
/// CoreFoundation type 'SecKey' will always succeed"), which makes
/// the conditional cast pattern useless as a safety net. The
/// `CFGetTypeID == SecKeyGetTypeID()` check IS the actual runtime
/// check; the subsequent `as!` is just the bridge once the type is
/// proven correct. Centralising it here means call sites never have
/// to write `as!` themselves and the contract is documented in one
/// place.
@usableFromInline
func bridgeToSecKey(_ ref: CFTypeRef) -> SecKey? {
    guard CFGetTypeID(ref) == SecKeyGetTypeID() else { return nil }
    return (ref as! SecKey)
}

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

    private static let signingKeyTag: String = {
        #if os(macOS)
        #if DEBUG
        return "chat.kraki.mac.dev.signing-key"
        #else
        return "chat.kraki.mac.signing-key"
        #endif
        #else
        return "chat.kraki.ios.signing-key"
        #endif
    }()
    private static let encryptionKeyTag: String = {
        #if os(macOS)
        #if DEBUG
        return "chat.kraki.mac.dev.encryption-key"
        #else
        return "chat.kraki.mac.encryption-key"
        #endif
        #else
        return "chat.kraki.ios.encryption-key"
        #endif
    }()

    #if os(macOS)
    /// macOS may deny access to a Keychain item after an app's signing
    /// identity changes. Keep a process-local fallback so a denied prompt
    /// does not strand the app offline. Authentication refreshes the relay's
    /// public keys through the existing CLI token flow; these keys are never
    /// written to disk.
    private static let ephemeralLock = NSLock()
    private static var preferEphemeralKeys = false
    private static var ephemeralSigningPair: (privateKey: SecKey, publicKey: SecKey)?
    private static var ephemeralEncryptionPair: (privateKey: SecKey, publicKey: SecKey)?
    private(set) var usingEphemeralKeys = false
    #endif

    /// Optional app group for shared keychain access (app ↔ notification extension).
    private let accessGroup: String?

    public init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    // MARK: - Public API

    #if os(macOS)
    /// Use process-local keys for a token-authenticated Mac launch. This
    /// avoids touching an old Keychain ACL at all; the relay receives the
    /// fresh public keys as part of the token-auth registration.
    public func activateEphemeralKeys() {
        Self.ephemeralLock.lock()
        Self.preferEphemeralKeys = true
        Self.ephemeralLock.unlock()
        usingEphemeralKeys = true
    }
    #endif

    /// Load or generate the signing key pair (for challenge-response auth).
    public func getOrCreateSigningKey() throws -> (privateKey: SecKey, publicKey: SecKey) {
        #if os(macOS)
        if Self.preferEphemeralKeys {
            usingEphemeralKeys = true
            return try ephemeralKeyPair(tag: Self.signingKeyTag)
        }
        #endif
        do {
            if let existing = try loadKeyPair(tag: Self.signingKeyTag) {
                return existing
            }
            return try generateAndStoreKeyPair(tag: Self.signingKeyTag)
        } catch {
            #if os(macOS)
            usingEphemeralKeys = true
            return try ephemeralKeyPair(tag: Self.signingKeyTag)
            #else
            throw error
            #endif
        }
    }

    /// Load or generate the encryption key pair (for E2E message decryption).
    public func getOrCreateEncryptionKey() throws -> (privateKey: SecKey, publicKey: SecKey) {
        #if os(macOS)
        if Self.preferEphemeralKeys {
            usingEphemeralKeys = true
            return try ephemeralKeyPair(tag: Self.encryptionKeyTag)
        }
        #endif
        do {
            if let existing = try loadKeyPair(tag: Self.encryptionKeyTag) {
                return existing
            }
            return try generateAndStoreKeyPair(tag: Self.encryptionKeyTag)
        } catch {
            #if os(macOS)
            usingEphemeralKeys = true
            return try ephemeralKeyPair(tag: Self.encryptionKeyTag)
            #else
            throw error
            #endif
        }
    }

    /// Check if both key pairs exist without generating them.
    public func hasKeys() -> Bool {
        #if os(macOS)
        if Self.ephemeralSigningPair != nil && Self.ephemeralEncryptionPair != nil {
            return true
        }
        #endif
        return (try? loadKeyPair(tag: Self.signingKeyTag)) != nil &&
               (try? loadKeyPair(tag: Self.encryptionKeyTag)) != nil
    }

    /// Delete all stored keys (for account reset or testing).
    public func deleteAllKeys() throws {
        #if os(macOS)
        defer {
            Self.ephemeralLock.lock()
            Self.preferEphemeralKeys = false
            Self.ephemeralSigningPair = nil
            Self.ephemeralEncryptionPair = nil
            Self.ephemeralLock.unlock()
        }
        #endif
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

        return try generateKeyPair(attributes: attrs)
    }

    #if os(macOS)
    private func ephemeralKeyPair(tag: String) throws -> (privateKey: SecKey, publicKey: SecKey) {
        Self.ephemeralLock.lock()
        defer { Self.ephemeralLock.unlock() }

        if tag == Self.signingKeyTag, let pair = Self.ephemeralSigningPair { return pair }
        if tag == Self.encryptionKeyTag, let pair = Self.ephemeralEncryptionPair { return pair }

        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits as String: 4096,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
        ]
        let pair = try generateKeyPair(attributes: attrs)
        if tag == Self.signingKeyTag {
            Self.ephemeralSigningPair = pair
        } else if tag == Self.encryptionKeyTag {
            Self.ephemeralEncryptionPair = pair
        }
        return pair
    }
    #endif

    private func generateKeyPair(attributes: [String: Any]) throws -> (privateKey: SecKey, publicKey: SecKey) {
        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
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

        // Bridge through the centralised helper so we never inline
        // an `as!` cast in call sites.
        guard let privateKey = bridgeToSecKey(ref),
              let publicKey = SecKeyCopyPublicKey(privateKey) else {
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
