/// KeychainManager — Secure RSA key storage using iOS Keychain.
///
/// Stores two RSA-4096 key pairs:
/// - Signing key (RSASSA-PKCS1-v1_5) for challenge-response auth
/// - Encryption key (RSA-OAEP) for E2E message decryption
///
/// Uses `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so the Notification
/// Service Extension can access keys in the background without requiring device
/// unlock, while the device identity never travels to another phone through a
/// backup restore (two phones sharing one device key).
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

    /// Tests: keep the secret files in this directory instead.
    static var testDirectory: URL?

    private static let defaultDirectory: URL = {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return base
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "chat.kraki.mac.dev", isDirectory: true)
            .appendingPathComponent("DevSecrets", isDirectory: true)
    }()

    static var directory: URL { testDirectory ?? defaultDirectory }

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
    ///
    /// The choice is process-wide: the auth path and the decryptor each own a
    /// KeychainManager and must never end up with one stored and one
    /// process-local key (nothing would decrypt).
    private static let ephemeralLock = NSLock()
    private static var preferEphemeralKeys = false
    private static var ephemeralSigningPair: (privateKey: SecKey, publicKey: SecKey)?
    private static var ephemeralEncryptionPair: (privateKey: SecKey, publicKey: SecKey)?
    /// Bumped whenever the process switches key pairs; a cached pair
    /// (EncryptionHandler) compares it before reuse.
    private static var pairGeneration = 0
    /// The CLI-login Mac's stored identity (see `useStoredIdentityIfPresent`),
    /// imported into memory: every signature and decryption uses these keys,
    /// never the Keychain. Guarded by `ephemeralLock`.
    private static var identityPairs: IdentityPairs?
    /// What this process's one read of the identity items found (nil: not
    /// read yet), updated with the items it stores. Guarded by `identityLock`.
    private static let identityLock = NSLock()
    private static var identityItems: IdentityItems?
    #if DEBUG
    /// Tests: the identity items exist but cannot be read without Keychain UI.
    static var debugIdentityItemsUnreadable = false
    /// Tests: storing an identity item fails.
    static var debugIdentityItemWriteFails = false
    #endif

    /// This process signs and decrypts with process-local keys.
    var usingEphemeralKeys: Bool { Self.isUsingEphemeralKeys }

    /// This process signs and decrypts with the stored identity (in memory).
    var usingStoredIdentity: Bool {
        Self.ephemeralLock.lock(); defer { Self.ephemeralLock.unlock() }
        return !Self.preferEphemeralKeys && Self.identityPairs != nil
    }

    private static var isUsingEphemeralKeys: Bool {
        ephemeralLock.lock(); defer { ephemeralLock.unlock() }
        return preferEphemeralKeys
    }

    /// Changes whenever the pair `getOrCreate…Key()` hands out changes.
    static var keyPairGeneration: Int {
        ephemeralLock.lock(); defer { ephemeralLock.unlock() }
        return pairGeneration
    }
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
        Self.useProcessLocalKeys(nil)
    }

    /// CLI-login Mac, choosing the stored-device challenge: sign and decrypt
    /// with the stored identity when both items were read without Keychain
    /// UI and imported. Never prompts, never creates anything.
    public func useStoredIdentityIfPresent() -> Bool {
        if Self.isUsingEphemeralKeys { return false }
        if usingStoredIdentity { return true }
        let items = Self.identityItemsReadOnce()
        guard !items.unreadable, let signing = items.signing, let encryption = items.encryption else { return false }
        return Self.adoptIdentity((signing, encryption))
    }

    /// CLI-login Mac, before a token sign-in: sign and decrypt with the
    /// stored identity, generating (in memory) and storing any missing item,
    /// so the next launch can sign in with a challenge. Returns whether this
    /// process's keys are stored. False means process-local keys: an item is
    /// unreadable without Keychain UI (it is never overwritten or deleted
    /// here), or storing failed.
    @discardableResult
    public func useStoredIdentityForTokenSignIn() -> Bool {
        if Self.isUsingEphemeralKeys { return false }
        if usingStoredIdentity { return true }
        switch Self.completeIdentityItems() {
        case .stored(let pairs):
            return Self.adoptIdentity(pairs)
        case .notStored(let pairs):
            Self.useProcessLocalKeys(pairs)
            return false
        }
    }
    #endif

    /// Load or generate the signing key pair (for challenge-response auth).
    public func getOrCreateSigningKey() throws -> (privateKey: SecKey, publicKey: SecKey) {
        #if os(macOS)
        return try processKeyPair(signing: true)
        #else
        if let existing = try loadKeyPair(tag: Self.signingKeyTag) {
            return existing
        }
        return try generateAndStoreKeyPair(tag: Self.signingKeyTag)
        #endif
    }

    /// Load or generate the encryption key pair (for E2E message decryption).
    public func getOrCreateEncryptionKey() throws -> (privateKey: SecKey, publicKey: SecKey) {
        #if os(macOS)
        return try processKeyPair(signing: false)
        #else
        if let existing = try loadKeyPair(tag: Self.encryptionKeyTag) {
            return existing
        }
        return try generateAndStoreKeyPair(tag: Self.encryptionKeyTag)
        #endif
    }

    /// Check if both key pairs exist without generating them.
    public func hasKeys() -> Bool {
        #if os(macOS)
        Self.ephemeralLock.lock()
        let processLocal = Self.preferEphemeralKeys, hasIdentity = Self.identityPairs != nil
        let hasProcessLocal = Self.ephemeralSigningPair != nil && Self.ephemeralEncryptionPair != nil
        Self.ephemeralLock.unlock()
        if processLocal { return hasProcessLocal }
        if hasIdentity { return true }
        #endif
        return (try? loadKeyPair(tag: Self.signingKeyTag)) != nil &&
               (try? loadKeyPair(tag: Self.encryptionKeyTag)) != nil
    }

    /// Delete all stored keys (for account reset or testing).
    public func deleteAllKeys() throws {
        #if os(macOS)
        defer { Self.forgetProcessKeys() }
        Self.deleteIdentityItems()
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
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
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
    /// The process-local pair, else the stored identity, else the legacy
    /// SecKey items (Macs signed in by pairing/OAuth without a CLI login),
    /// falling back to process-local keys when those are denied.
    private func processKeyPair(signing: Bool) throws -> (privateKey: SecKey, publicKey: SecKey) {
        let tag = signing ? Self.signingKeyTag : Self.encryptionKeyTag
        Self.ephemeralLock.lock()
        let processLocal = Self.preferEphemeralKeys, identity = Self.identityPairs
        Self.ephemeralLock.unlock()
        if processLocal { return try ephemeralKeyPair(tag: tag) }
        if let identity { return signing ? identity.signing : identity.encryption }
        do {
            if let existing = try loadKeyPair(tag: tag) { return existing }
            return try generateAndStoreKeyPair(tag: tag)
        } catch {
            activateEphemeralKeys()
            return try ephemeralKeyPair(tag: tag)
        }
    }

    private static func useProcessLocalKeys(_ pairs: IdentityPairs?) {
        ephemeralLock.lock(); defer { ephemeralLock.unlock() }
        if !preferEphemeralKeys { pairGeneration += 1 }
        preferEphemeralKeys = true
        if let pairs, ephemeralSigningPair == nil, ephemeralEncryptionPair == nil {
            ephemeralSigningPair = pairs.signing
            ephemeralEncryptionPair = pairs.encryption
        }
    }

    /// Returns false when the process already moved to process-local keys.
    private static func adoptIdentity(_ pairs: IdentityPairs) -> Bool {
        ephemeralLock.lock(); defer { ephemeralLock.unlock() }
        guard !preferEphemeralKeys else { return false }
        if identityPairs == nil { pairGeneration += 1 }
        identityPairs = pairs
        return true
    }

    private static func forgetProcessKeys() {
        ephemeralLock.lock()
        preferEphemeralKeys = false
        ephemeralSigningPair = nil
        ephemeralEncryptionPair = nil
        identityPairs = nil
        pairGeneration += 1
        ephemeralLock.unlock()
        identityLock.lock()
        identityItems = nil
        identityLock.unlock()
    }

    #if DEBUG
    /// Tests: forget this process's key choice (stored keys stay).
    static func debugResetProcessKeys() {
        forgetProcessKeys()
    }
    #endif

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

    /// Keys created by earlier versions were `AfterFirstUnlock` and so were
    /// included in encrypted backups. Tighten them once, in place (best effort:
    /// a failure leaves the key usable exactly as before).
    private func migrateToThisDeviceOnly(tag: String) {
        let flag = "kraki.keychain.thisDeviceOnly.\(tag)"
        guard !UserDefaults.standard.bool(forKey: flag) else { return }
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        ]
        if let group = accessGroup { query[kSecAttrAccessGroup as String] = group }
        let update = [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            UserDefaults.standard.set(true, forKey: flag)
        } else {
            KLog.d("⚠️ Keychain accessibility migration failed for \(tag): \(status)")
        }
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
        if status == errSecSuccess { migrateToThisDeviceOnly(tag: tag) }
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

// MARK: - Mac stored identity (key bytes in generic-password items)

#if os(macOS)
extension KeychainManager {
    typealias IdentityPairs = (signing: (privateKey: SecKey, publicKey: SecKey),
                               encryption: (privateKey: SecKey, publicKey: SecKey))

    /// The CLI-login Mac keeps its identity as key bytes: one generic-password
    /// item per pair (account = the key tag) holding the private key's
    /// `SecKeyCopyExternalRepresentation` DER, as Debug keeps them in files.
    /// A SecKey item in the file-based login keychain costs ~58 ms per
    /// RSA-4096 signature or decryption and can raise a Keychain dialog on
    /// any use; the imported in-memory key costs ~4–6 ms and never touches
    /// the Keychain again (M5 Pro, throwaway keychain, 2026-11-28). An edge
    /// Head verifies a returning device itself only while both public keys
    /// stay the same, so both pairs persist.
    static let identityService: String = {
        #if KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY
        return "\(Bundle.main.bundleIdentifier ?? "chat.kraki.diag").identity"
        #elseif DEBUG
        return "chat.kraki.mac.dev.identity"
        #else
        return "chat.kraki.mac.identity"
        #endif
    }()

    fileprivate struct IdentityItems {
        var signing: (privateKey: SecKey, publicKey: SecKey)?
        var encryption: (privateKey: SecKey, publicKey: SecKey)?
        /// An item exists but was not readable without Keychain UI (or did
        /// not import): this process uses process-local keys and never
        /// overwrites or deletes it.
        var unreadable = false
    }

    fileprivate enum IdentityCompletion {
        case stored(IdentityPairs)
        /// Process-local keys; the pairs when they were generated here.
        case notStored(IdentityPairs?)
    }

    private enum IdentityItemRead {
        case found((privateKey: SecKey, publicKey: SecKey))
        case missing
        case unreadable
    }

    fileprivate static func identityItemsReadOnce() -> IdentityItems {
        identityLock.lock(); defer { identityLock.unlock() }
        return readIdentityItemsLocked()
    }

    /// Each item is read at most once per process.
    private static func readIdentityItemsLocked() -> IdentityItems {
        if let items = identityItems { return items }
        var items = IdentityItems()
        for tag in [signingKeyTag, encryptionKeyTag] {
            switch readIdentityItem(account: tag) {
            case .found(let pair):
                if tag == signingKeyTag { items.signing = pair } else { items.encryption = pair }
            case .missing:
                break
            case .unreadable:
                items.unreadable = true
            }
        }
        identityItems = items
        return items
    }

    /// Read both items, generate any missing pair in memory and store it.
    fileprivate static func completeIdentityItems() -> IdentityCompletion {
        identityLock.lock(); defer { identityLock.unlock() }
        var items = readIdentityItemsLocked()
        guard !items.unreadable else { return .notStored(nil) }
        var stored = true
        func completed(_ item: WritableKeyPath<IdentityItems, (privateKey: SecKey, publicKey: SecKey)?>,
                       account: String) throws -> (privateKey: SecKey, publicKey: SecKey) {
            if let existing = items[keyPath: item] { return existing }
            let generated = try makeProcessLocalKeyPair()
            if writeIdentityItem(generated.privateKey, account: account) {
                items[keyPath: item] = generated
            } else {
                stored = false
            }
            return generated
        }
        defer { identityItems = items }
        do {
            let pairs = (signing: try completed(\.signing, account: signingKeyTag),
                         encryption: try completed(\.encryption, account: encryptionKeyTag))
            return stored ? .stored(pairs) : .notStored(pairs)
        } catch {
            KLog.diag("Keychain: identity key generation failed (\(error))")
            return .notStored(nil)
        }
    }

    private static func readIdentityItem(account: String) -> IdentityItemRead {
        #if DEBUG
        if debugIdentityItemsUnreadable { return .unreadable }
        if DevSecretFileStore.isEnabled {
            guard let der = DevSecretFileStore.read(identityFileName(account)) else { return .missing }
            return importIdentityKey(der).map(IdentityItemRead.found) ?? .unreadable
        }
        #endif
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: identityService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = withoutKeychainUI { SecItemCopyMatching(query as CFDictionary, &result) }
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let der = result as? Data, let pair = importIdentityKey(der) else {
            KLog.diag("Keychain: identity item \(account) not readable without UI (\(status)) — not used")
            return .unreadable
        }
        return .found(pair)
    }

    private static func writeIdentityItem(_ privateKey: SecKey, account: String) -> Bool {
        guard let der = SecKeyCopyExternalRepresentation(privateKey, nil) as Data? else { return false }
        #if DEBUG
        if debugIdentityItemWriteFails { return false }
        if DevSecretFileStore.isEnabled { return DevSecretFileStore.write(der, name: identityFileName(account)) }
        #endif
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: identityService,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: "Kraki",   // account says which key pair
            kSecValueData as String: der,
        ]
        let status = withoutKeychainUI { SecItemAdd(item as CFDictionary, nil) }
        if status != errSecSuccess { KLog.diag("Keychain: storing identity item \(account) failed (\(status))") }
        return status == errSecSuccess
    }

    /// Sign Out, Delete Account, a cleared identity.
    static func deleteIdentityItems() {
        for account in [signingKeyTag, encryptionKeyTag] {
            #if DEBUG
            if DevSecretFileStore.isEnabled { DevSecretFileStore.delete(identityFileName(account)); continue }
            #endif
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: identityService,
                kSecAttrAccount as String: account,
            ]
            _ = withoutKeychainUI { SecItemDelete(query as CFDictionary) }
        }
    }

    #if DEBUG
    static func identityFileName(_ account: String) -> String { "identity.\(account)" }
    #endif

    /// On the modern SecKey implementation, like `makeProcessLocalKeyPair`.
    /// Usable only when the public key derives and exports cleanly.
    private static func importIdentityKey(_ der: Data) -> (privateKey: SecKey, publicKey: SecKey)? {
        let base: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        ]
        var modern = base
        modern[kSecUseDataProtectionKeychain as String] = true
        guard let privateKey = SecKeyCreateWithData(der as CFData, modern as CFDictionary, nil)
                ?? SecKeyCreateWithData(der as CFData, base as CFDictionary, nil),
              let publicKey = SecKeyCopyPublicKey(privateKey),
              SecKeyCopyExternalRepresentation(publicKey, nil) != nil else { return nil }
        return (privateKey: privateKey, publicKey: publicKey)
    }

    private static let keychainUILock = NSLock()

    /// Runs one Keychain call with Keychain UI disallowed, then restores the
    /// previous setting. On macOS `kSecUseAuthenticationUI` covers only the
    /// Data Protection keychain; for the file-based login keychain only this
    /// process-wide switch turns a would-be dialog into an error (a denied
    /// item answered errSecAuthFailed in ~8 ms). It is process-wide, so it
    /// spans exactly one call.
    private static func withoutKeychainUI(_ call: () -> OSStatus) -> OSStatus {
        keychainUILock.lock(); defer { keychainUILock.unlock() }
        var allowed: DarwinBoolean = true
        SecKeychainGetUserInteractionAllowed(&allowed)
        SecKeychainSetUserInteractionAllowed(false)
        defer { SecKeychainSetUserInteractionAllowed(allowed.boolValue) }
        return call()
    }
}
#endif
