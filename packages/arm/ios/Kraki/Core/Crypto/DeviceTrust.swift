/// Device trust — the app side of docs/e2e-trust.md.
///
/// The relay distributes public keys, so on its own E2E encryption cannot
/// stop a compromised relay from swapping keys or encrypting commands to a
/// computer. Device trust takes the relay out of that decision:
///
/// - This device has an **identity key** (Ed25519) and an **X25519 key** that
///   never leave it.
/// - A computer is **pinned** from its pairing QR (`tid`, `ik`, `xk`) or, for
///   the computer on this Mac, from `~/.kraki` — never from the relay.
/// - The app **pairs** by sending `pair_request`: its keys, signed with its
///   identity key, plus an HMAC under the QR's one-time secret (`ps`) the relay
///   never saw. Same-Mac pairing proves itself by writing a private file.
/// - After pairing, every message to that computer is signed and encrypted to
///   its pinned X25519 key, and only messages it signed are accepted from it.
///
/// Wire format is byte-compatible with packages/crypto/src/trust.ts.
///
/// Also compiled into the iOS Notification Service Extension (push previews),
/// so it depends only on Foundation, CryptoKit, Security and CoinfraCrypto.

import CoinfraCrypto
import CryptoKit
import Foundation
import Security

/// Defaults shared with the iOS Notification Service Extension; per-app on
/// macOS (Prod and Dev must not share pins). Mirrors AppState.sharedDefaults.
enum DeviceTrustDefaults {
    static var shared: UserDefaults {
        #if KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY && os(iOS)
        return UserDefaults(suiteName: "group.chat.kraki.ios.diag") ?? .standard
        #elseif KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY
        return .standard
        #elseif os(macOS)
        #if DEBUG
        return UserDefaults(suiteName: "chat.kraki.mac.dev") ?? .standard
        #else
        return UserDefaults(suiteName: "chat.kraki.mac") ?? .standard
        #endif
        #else
        return UserDefaults(suiteName: "group.chat.kraki.ios") ?? .standard
        #endif
    }
}

// MARK: - Wire

enum DeviceTrustWire {
    static let feature = "device_trust"
    static let anyRecipient = "*"
    private static let sigContext = "kraki-sig/1"
    private static let pairContext = "kraki-pair/1"

    static func b64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func fromB64url(_ text: String) -> Data? {
        guard text.allSatisfy({ $0.isLetter && $0.isASCII || $0.isNumber && $0.isASCII || $0 == "-" || $0 == "_" }),
              text.count % 4 != 1 else { return nil }
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let data = Data(base64Encoded: s), b64url(data) == text else { return nil }
        return data
    }

    static func isRawKey(_ value: String?) -> Bool {
        guard let value, value.count == 43 else { return false }
        return fromB64url(value)?.count == 32
    }

    /// Same rule as `isFileSafeId` in trust.ts (`local-enroll/<id>.json`).
    static func isFileSafeId(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 && value.unicodeScalars.allSatisfy {
            ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5a)
                || ($0.value >= 0x61 && $0.value <= 0x7a) || $0 == "_" || $0 == "-"
        }
    }

    /// Same rule as `isWireId` in trust.ts: delimiter-free, 1…128 chars.
    static func isWireId(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 && !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }

    private static func signingInput(from: String, to: String, ts: Int64, nonce: String, body: String) -> Data {
        Data("\(sigContext)\n\(from)\n\(to)\n\(ts)\n\(nonce)\n\(body)".utf8)
    }

    /// Wrap `body` (a JSON string) in a signed message.
    static func sign(
        body: String,
        from: String,
        to: String,
        key: Curve25519.Signing.PrivateKey,
        ts: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        nonce: String? = nil
    ) throws -> [String: Any] {
        let nonce = nonce ?? {
            var bytes = [UInt8](repeating: 0, count: 16)
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            return b64url(Data(bytes))
        }()
        let sig = try key.signature(for: signingInput(from: from, to: to, ts: ts, nonce: nonce, body: body))
        return ["ks": 1, "from": from, "to": to, "ts": ts, "nonce": nonce, "body": body, "sig": b64url(sig)]
    }

    struct Signed {
        let from: String
        let to: String
        let ts: Int64
        let nonce: String
        let body: String
        let sig: String
    }

    static func parseSigned(_ object: [String: Any]) -> Signed? {
        guard (object["ks"] as? NSNumber)?.intValue == 1,
              let from = object["from"] as? String, isWireId(from),
              let to = object["to"] as? String, isWireId(to),
              let ts = (object["ts"] as? NSNumber)?.int64Value, ts >= 0,
              let nonce = object["nonce"] as? String, nonce.count == 22, fromB64url(nonce)?.count == 16,
              let body = object["body"] as? String,
              let sig = object["sig"] as? String else { return nil }
        return Signed(from: from, to: to, ts: ts, nonce: nonce, body: body, sig: sig)
    }

    static func verify(_ m: Signed, publicKey: String) -> Bool {
        guard let raw = fromB64url(publicKey), raw.count == 32,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw),
              let sig = fromB64url(m.sig), sig.count == 64 else { return false }
        return key.isValidSignature(sig, for: signingInput(from: m.from, to: m.to, ts: m.ts, nonce: m.nonce, body: m.body))
    }

    /// `1234 5678 9012` — same as `safetyCode` in trust.ts. Users compare it
    /// with `kraki devices` on the computer.
    static func safetyCode(_ identityKey: String) -> String? {
        guard let raw = fromB64url(identityKey), raw.count == 32 else { return nil }
        let digest = Array(SHA256.hash(data: raw))
        let n = digest.prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } % 1_000_000_000_000
        let s = String(format: "%012llu", n)
        let a = s.index(s.startIndex, offsetBy: 4), b = s.index(s.startIndex, offsetBy: 8)
        return "\(s[..<a]) \(s[a..<b]) \(s[b...])"
    }

    /// HMAC-SHA256 under the QR secret over the keys being enrolled.
    static func pairingProof(
        secret: String, tentacleId: String, appId: String,
        identityKey: String, encryptionKey: String, rsaKey: String?, ts: Int64
    ) -> String? {
        guard let key = fromB64url(secret) else { return nil }
        let input = "\(pairContext)\n\(tentacleId)\n\(appId)\n\(identityKey)\n\(encryptionKey)\n\(rsaKey ?? "")\n\(ts)"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(input.utf8), using: SymmetricKey(data: key))
        return b64url(Data(mac))
    }
}

// MARK: - This device's keys

/// The identity (Ed25519) and E2E (X25519) keys of this app install.
///
/// Both must survive relaunches (computers pin them). iOS keeps them in the
/// Keychain (AfterFirstUnlock); macOS keeps them in 0600 files in Application
/// Support, the same trust level as the CLI's `~/.kraki/keys` and free of
/// Keychain ACL prompts after re-signing.
final class DeviceIdentityKeys {
    static let shared = DeviceIdentityKeys()

    #if DEBUG
    /// Tests: keep keys in this directory instead of the real store.
    static var testDirectory: URL?
    #endif

    private let lock = NSLock()
    private var signing: Curve25519.Signing.PrivateKey?
    private var agreement: Curve25519.KeyAgreement.PrivateKey?

    func signingKey() throws -> Curve25519.Signing.PrivateKey {
        lock.lock(); defer { lock.unlock() }
        if let signing { return signing }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: try loadOrCreate("identity-ed25519") {
            Curve25519.Signing.PrivateKey().rawRepresentation
        })
        signing = key
        return key
    }

    func agreementKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        lock.lock(); defer { lock.unlock() }
        if let agreement { return agreement }
        let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: try loadOrCreate("e2e-x25519") {
            Curve25519.KeyAgreement.PrivateKey().rawRepresentation
        })
        agreement = key
        return key
    }

    /// The X25519 key if it exists — never creates one (Notification Service Extension).
    func existingAgreementKey() -> Curve25519.KeyAgreement.PrivateKey? {
        lock.lock(); defer { lock.unlock() }
        if let agreement { return agreement }
        guard let raw = load("e2e-x25519") else { return nil }
        return try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }

    var identityPublicKey: String? { (try? signingKey()).map { DeviceTrustWire.b64url($0.publicKey.rawRepresentation) } }
    var encryptionPublicKey: String? { (try? agreementKey()).map { DeviceTrustWire.b64url($0.publicKey.rawRepresentation) } }

    /// Forget both keys (logout / account deletion). Computers must re-pair.
    func reset() {
        lock.lock(); defer { lock.unlock() }
        signing = nil
        agreement = nil
        for name in ["identity-ed25519", "e2e-x25519"] { delete(name) }
    }

    // MARK: Storage

    private func loadOrCreate(_ name: String, generate: () -> Data) throws -> Data {
        if let data = load(name) { return data }
        let data = generate()
        try store(data, name: name)
        return data
    }

    private var directory: URL? {
        #if DEBUG
        if let testDirectory = Self.testDirectory { return testDirectory }
        #endif
        #if os(macOS)
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "chat.kraki.mac", isDirectory: true)
            .appendingPathComponent("DeviceTrust", isDirectory: true)
        #else
        return nil
        #endif
    }

    private static let service: String = {
        #if KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY
        return "chat.kraki.diag.device-trust"
        #else
        return "chat.kraki.device-trust"
        #endif
    }()

    private func load(_ name: String) -> Data? {
        if let dir = directory {
            return (try? String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8))
                .flatMap { DeviceTrustWire.fromB64url($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: name,
            kSecReturnData as String: true,
        ]
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private func store(_ data: Data, name: String) throws {
        if let dir = directory {
            let fm = FileManager.default
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let url = dir.appendingPathComponent(name)
            try Data(DeviceTrustWire.b64url(data).utf8).write(to: url, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return
        }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: name,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Keychain save failed"])
        }
    }

    private func delete(_ name: String) {
        if let dir = directory {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            return
        }
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: name,
        ] as CFDictionary)
    }
}

// MARK: - Pinned computers

struct TentaclePin: Codable, Equatable {
    var identityKey: String
    var encryptionKey: String
    /// The computer confirmed the pairing (a `pair_result` it signed).
    var paired: Bool
    /// One-time QR secret, until the pairing is confirmed.
    var secret: String?
    /// "qr" or "local".
    var via: String
    var pinnedAt: Date
    /// The computer accepts only paired apps.
    var enforced: Bool?
    /// Last pairing failure reported by the computer.
    var lastError: String?
}

/// Pins per computer. Thread-safe: read from the background decrypt queue.
final class TentacleTrustStore {
    static let shared = TentacleTrustStore()

    private static let storageKey = "kraki.deviceTrust.pins.v1"
    private let lock = NSLock()
    private var defaults: UserDefaults
    private var pins: [String: TentaclePin]

    /// Called on the main queue after any change (drives the UI).
    var onChange: (() -> Void)?

    init(defaults: UserDefaults = DeviceTrustDefaults.shared) {
        self.defaults = defaults
        self.pins = Self.load(defaults)
    }

    private static func load(_ defaults: UserDefaults) -> [String: TentaclePin] {
        guard let data = defaults.data(forKey: storageKey),
              let pins = try? JSONDecoder().decode([String: TentaclePin].self, from: data) else { return [:] }
        return pins
    }

    #if DEBUG
    /// Tests: use an isolated defaults domain.
    func useDefaults(_ defaults: UserDefaults) {
        lock.lock()
        self.defaults = defaults
        self.pins = Self.load(defaults)
        lock.unlock()
        notify()
    }
    #endif

    func pin(_ tentacleId: String) -> TentaclePin? {
        lock.lock(); defer { lock.unlock() }
        return pins[tentacleId]
    }

    /// Pinned and confirmed: everything to/from it is signed X25519.
    func pairedPin(_ tentacleId: String) -> TentaclePin? {
        guard let pin = pin(tentacleId), pin.paired else { return nil }
        return pin
    }

    var hasPaired: Bool {
        lock.lock(); defer { lock.unlock() }
        return pins.values.contains { $0.paired }
    }

    /// Any computer pinned (paired, pairing or refused).
    var hasPins: Bool {
        lock.lock(); defer { lock.unlock() }
        return !pins.isEmpty
    }

    var all: [String: TentaclePin] {
        lock.lock(); defer { lock.unlock() }
        return pins
    }

    func update(_ tentacleId: String, _ change: (inout TentaclePin?) -> Void) {
        lock.lock()
        var pin = pins[tentacleId]
        change(&pin)
        pins[tentacleId] = pin
        let snapshot = pins
        lock.unlock()
        if let data = try? JSONEncoder().encode(snapshot) { defaults.set(data, forKey: Self.storageKey) }
        notify()
    }

    func reset() {
        lock.lock(); pins = [:]; lock.unlock()
        defaults.removeObject(forKey: Self.storageKey)
        notify()
    }

    private func notify() {
        guard let onChange else { return }
        if Thread.isMainThread { onChange() } else { DispatchQueue.main.async(execute: onChange) }
    }
}

// MARK: - Receive-side check

enum DeviceTrustInbound {
    enum Outcome {
        /// Inner message JSON to route.
        case message(Data)
        case rejected(String)
    }

    /// Marker on unsigned inner messages; MessageRouter (on the main actor,
    /// where session ownership is known) drops any that touch a session of a
    /// paired computer.
    static let unsignedKey = "__krakiUnsigned"
    /// Session ownership: a pinned claimant outranks an unpinned owner.
    static func claimantOutranksOwner(_ claimant: String, _ owner: String) -> Bool {
        TentacleTrustStore.shared.pin(claimant) != nil && TentacleTrustStore.shared.pin(owner) == nil
    }

    /// Marker on signed inner messages: the verified signer (a pinned computer).
    static let signedByKey = "__krakiSignedBy"

    /// Authenticate a decrypted payload. `src` is the relay/link sender stamp.
    static func check(
        plaintext: String,
        src: String?,
        selfId: String,
        store: TentacleTrustStore = .shared
    ) -> Outcome {
        guard let data = plaintext.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .rejected("bad_json")
        }
        if let signed = DeviceTrustWire.parseSigned(object) {
            if let src, src != signed.from { return .rejected("sender_mismatch") }
            guard let pin = store.pin(signed.from) else {
                // A computer we have no key for can only tell us it wants
                // pairing (a hint for the UI: nothing secret, nothing acted on).
                if let inner = try? JSONSerialization.jsonObject(with: Data(signed.body.utf8)) as? [String: Any],
                   inner["type"] as? String == "trust_required",
                   var hint = Optional(inner) {
                    hint["deviceId"] = signed.from
                    hint[unsignedKey] = true
                    if let out = try? JSONSerialization.data(withJSONObject: hint) { return .message(out) }
                }
                return .rejected("unpinned_signer")
            }
            guard DeviceTrustWire.verify(signed, publicKey: pin.identityKey) else { return .rejected("bad_signature") }
            guard signed.to == selfId || signed.to == DeviceTrustWire.anyRecipient else { return .rejected("wrong_recipient") }
            guard var inner = try? JSONSerialization.jsonObject(with: Data(signed.body.utf8)) as? [String: Any] else {
                return .rejected("bad_body")
            }
            if let claimed = inner["deviceId"] as? String, !claimed.isEmpty, claimed != signed.from {
                return .rejected("device_mismatch")
            }
            inner["deviceId"] = signed.from
            inner[signedByKey] = signed.from
            inner.removeValue(forKey: unsignedKey)
            guard let out = try? JSONSerialization.data(withJSONObject: inner) else { return .rejected("bad_body") }
            return .message(out)
        }
        // Unsigned: legacy computers only. Anything attributable to a pinned
        // computer (paired, or pairing — protection starts at pinning) — by
        // stamp or claimed sender here, by the sessions it touches in
        // MessageRouter — is forged: such a computer always signs.
        var marked = object
        marked.removeValue(forKey: signedByKey)
        guard store.hasPins else {
            marked[unsignedKey] = true
            guard let out = try? JSONSerialization.data(withJSONObject: marked) else { return .rejected("bad_json") }
            return .message(out)
        }
        let claimed = object["deviceId"] as? String
        // Without a claimed sender it cannot be told apart from a pinned computer.
        guard let claimed, !claimed.isEmpty else { return .rejected("unsigned_unattributed") }
        for id in [src, claimed].compactMap({ $0 }) where store.pin(id) != nil {
            // The id lets the app notice a computer that stopped signing
            // (e.g. Kraki downgraded there).
            return .rejected("unsigned_from_pinned:\(id)")
        }
        marked[unsignedKey] = true
        guard let out = try? JSONSerialization.data(withJSONObject: marked) else { return .rejected("bad_json") }
        return .message(out)
    }
}

// MARK: - Push previews

/// Device-trust push previews: the computer signs the preview and encrypts it
/// to this device's X25519 key; the Head forwards it as `key` = `v2.<envelope>`
/// (see packages/tentacle/src/relay/push-preview.ts).
enum DeviceTrustPush {
    static let prefix = "v2."
    /// A preview older than this is a replay by the Head, not news.
    static let maxAge: TimeInterval = 24 * 3600

    enum Failure: Error { case notV2, decrypt, unsigned, unpinned, badSignature, wrongRecipient, stale }

    /// Whether an unsigned (legacy RSA) preview may be shown. Once any
    /// computer is pinned, never: RSA ciphertext proves nothing about its
    /// sender, and the extension cannot reliably know which sessions belong
    /// to which computer. Unpaired computers' previews then show generic text.
    static func legacyPreviewAllowed(store: TentacleTrustStore = .shared) -> Bool {
        !store.hasPins
    }

    /// The preview JSON, verified to come from a pinned computer.
    static func open(
        key: String,
        selfId: String,
        agreementKey: Curve25519.KeyAgreement.PrivateKey,
        store: TentacleTrustStore = .shared,
        now: Date = Date()
    ) throws -> String {
        guard key.hasPrefix(prefix) else { throw Failure.notV2 }
        guard let plaintext = try? CoinfraCrypto.decryptFromBlob(String(key.dropFirst(prefix.count)), recipientId: selfId, privateKey: agreementKey),
              let object = try? JSONSerialization.jsonObject(with: Data(plaintext.utf8)) as? [String: Any] else {
            throw Failure.decrypt
        }
        guard let signed = DeviceTrustWire.parseSigned(object) else { throw Failure.unsigned }
        guard let pin = store.pin(signed.from) else { throw Failure.unpinned }
        guard DeviceTrustWire.verify(signed, publicKey: pin.identityKey) else { throw Failure.badSignature }
        guard signed.to == selfId else { throw Failure.wrongRecipient }
        let age = now.timeIntervalSince1970 - Double(signed.ts) / 1000
        guard age < maxAge, age > -600 else { throw Failure.stale }
        return signed.body
    }
}
