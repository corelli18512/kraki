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

// MARK: - Mac Debug secret files

#if os(macOS) && DEBUG
/// Secrets of Mac Debug builds live in 0600 files instead of the login
/// keychain.
///
/// Debug builds (Xcode, agents' `xcodebuild`, scripts/test-native.sh) are
/// usually ad-hoc signed, so every rebuild has a new code identity. A keychain
/// item's ACL is bound to the identity that created it, so the next build
/// reading it makes macOS ask for the login password ("Kraki (Dev) wants to
/// use your confidential information…") on every launch. Developer secrets do
/// not need keychain protection; the CLI keeps its keys in ~/.kraki/keys too.
/// Set KRAKI_DEV_USE_KEYCHAIN=1 to exercise the real keychain path.
enum DevSecretFileStore {
    static var isEnabled: Bool {
        ProcessInfo.processInfo.environment["KRAKI_DEV_USE_KEYCHAIN"] != "1"
    }

    static let directory: URL = {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return base
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "chat.kraki.mac.dev", isDirectory: true)
            .appendingPathComponent("DevSecrets", isDirectory: true)
    }()

    private static func url(_ name: String) -> URL {
        directory.appendingPathComponent(name)
    }

    static func read(_ name: String) -> Data? {
        try? Data(contentsOf: url(name))
    }

    @discardableResult
    static func write(_ data: Data, name: String) -> Bool {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            try data.write(to: url(name), options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url(name).path)
            return true
        } catch {
            return false
        }
    }

    static func delete(_ name: String) {
        try? FileManager.default.removeItem(at: url(name))
    }
}
#endif

// MARK: - KeychainManager

public final class KeychainManager {

    private static let signingKeyTag: String = {
        #if KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY
        return "\(Bundle.main.bundleIdentifier ?? "chat.kraki.diag").signing-key"
        #elseif os(macOS)
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
        #if KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY
        return "\(Bundle.main.bundleIdentifier ?? "chat.kraki.diag").encryption-key"
        #elseif os(macOS)
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
        #if os(macOS) && DEBUG
        if DevSecretFileStore.isEnabled {
            let pair = try Self.makeProcessLocalKeyPair()
            var error: Unmanaged<CFError>?
            guard let der = SecKeyCopyExternalRepresentation(pair.privateKey, &error) as Data?,
                  DevSecretFileStore.write(der, name: tag) else {
                throw KeychainError.saveFailed(errSecIO)
            }
            return pair
        }
        #endif
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

        let pair = try Self.makeProcessLocalKeyPair()
        if tag == Self.signingKeyTag {
            Self.ephemeralSigningPair = pair
        } else if tag == Self.encryptionKeyTag {
            Self.ephemeralEncryptionPair = pair
        }
        return pair
    }

    /// Process-local RSA-4096 pair on macOS's modern (corecrypto) SecKey
    /// implementation. A plain in-memory key lands on the legacy CDSA path,
    /// whose OAEP decrypt costs ~29 ms per inbound message on an M5 Pro
    /// (~5 ms here); the key format and every wire byte are unchanged. The key
    /// is never stored, so no keychain entitlement is involved. Falls back to
    /// the legacy implementation if the modern one is unavailable.
    static func makeProcessLocalKeyPair() throws -> (privateKey: SecKey, publicKey: SecKey) {
        let base: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits as String: 4096,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
        ]
        var modern = base
        modern[kSecUseDataProtectionKeychain as String] = true
        if let pair = try? createPair(modern) { return pair }
        return try createPair(base)
    }

    #if DEBUG
    /// Benchmark/test seam: the pre-change legacy in-memory pair.
    static func makeLegacyProcessLocalKeyPairForTesting() throws -> (privateKey: SecKey, publicKey: SecKey) {
        try createPair([
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits as String: 4096,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
        ])
    }
    #endif

    private static func createPair(_ attributes: [String: Any]) throws -> (privateKey: SecKey, publicKey: SecKey) {
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
        #if os(macOS) && DEBUG
        if DevSecretFileStore.isEnabled {
            guard let der = DevSecretFileStore.read(tag) else { return nil }
            let attrs: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
                kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            ]
            guard let privateKey = SecKeyCreateWithData(der as CFData, attrs as CFDictionary, nil),
                  let publicKey = SecKeyCopyPublicKey(privateKey) else {
                throw KeychainError.unexpectedData
            }
            return (privateKey: privateKey, publicKey: publicKey)
        }
        #endif
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
        #if os(macOS) && DEBUG
        if DevSecretFileStore.isEnabled {
            DevSecretFileStore.delete(tag)
            return
        }
        #endif
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
