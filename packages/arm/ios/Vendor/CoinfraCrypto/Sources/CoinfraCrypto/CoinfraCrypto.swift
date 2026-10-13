// CoinfraCrypto — Swift (CryptoKit) implementation of @coinfra/crypto suite v1.
//
// Byte-for-byte compatible with packages/crypto/src/index.ts:
//   - key encapsulation: per-recipient ephemeral X25519 ECDH + HKDF-SHA256
//     (salt empty, info = "coinfra-crypto/v1 kek" ‖ epk)
//   - content + key wrap: AES-256-GCM
//       wrap AAD    = epk ‖ utf8(recipientId)
//       content AAD = utf8("X25519-HKDF-SHA256/AES-256-GCM#1")
//   - signatures: Ed25519 over utf8("coinfra-crypto/v1 challenge\n") ‖ utf8(nonce)
//   - compact blob: c0 1f | v=1 | suite=1 | u8 ivLen iv | u32 ctLen ct | u16 n |
//     n × (u16 idLen id | u16 epkLen epk | u16 keyLen key), all base64url
//   - public keys: raw 32-byte base64url; private keys: PKCS#8 base64url
//
// Interop is pinned by fixtures/ts-vectors.json and fixtures/swift-vectors.json.

import CryptoKit
import Foundation

public enum CoinfraCryptoError: Error, Equatable {
    case noRecipients
    case invalidBase64url
    case nonCanonicalBase64url
    case invalidKey(String)
    case notAnEnvelope
    case unsupportedVersion(Int)
    case unsupportedSuite(Int)
    case truncatedEnvelope
    case fieldTooLarge(String)
    case noKeyForRecipient(String)
    case decryptionFailed
    case invalidUTF8
}

public enum CoinfraCrypto {
    public static let envelopeVersion = 1
    public static let suiteId: UInt8 = 1
    public static let suiteName = "X25519-HKDF-SHA256/AES-256-GCM"

    static let magic: [UInt8] = [0xc0, 0x1f]
    static let ivSize = 12
    static let cekSize = 32
    static let hkdfInfoLabel = Array("coinfra-crypto/v1 kek".utf8)
    static let challengeContext = Array("coinfra-crypto/v1 challenge\n".utf8)

    // MARK: Types

    /// base64url public key (raw 32 bytes) + base64url PKCS#8 private key.
    public struct KeyPair: Equatable, Sendable {
        public let publicKey: String
        public let privateKey: String
    }

    public struct Recipient: Sendable {
        public let recipientId: String
        public let publicKey: String
        public init(recipientId: String, publicKey: String) {
            self.recipientId = recipientId
            self.publicKey = publicKey
        }
    }

    public struct RecipientEntry: Equatable, Sendable {
        /// base64url ephemeral X25519 public key (32 bytes).
        public let epk: String
        /// base64url `iv ‖ AES-GCM(cek) ‖ tag`.
        public let key: String
    }

    public struct Envelope: Equatable, Sendable {
        public let v: Int
        public let suite: String
        public let iv: String
        public let ciphertext: String
        public let recipients: [String: RecipientEntry]
        /// Recipient order as serialized (Swift dictionaries are unordered).
        public let recipientOrder: [String]
    }

    // MARK: Keys

    public static func generateEncryptionKeyPair() -> KeyPair {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(
            publicKey: base64url(key.publicKey.rawRepresentation),
            privateKey: base64url(PKCS8.x25519(key.rawRepresentation))
        )
    }

    public static func generateSigningKeyPair() -> KeyPair {
        let key = Curve25519.Signing.PrivateKey()
        return KeyPair(
            publicKey: base64url(key.publicKey.rawRepresentation),
            privateKey: base64url(PKCS8.ed25519(key.rawRepresentation))
        )
    }

    /// Import a base64url PKCS#8 X25519 private key once for reuse in `decrypt`.
    public static func importEncryptionPrivateKey(_ privateKey: String) throws -> Curve25519.KeyAgreement.PrivateKey {
        let raw = try PKCS8.unwrap(try fromBase64url(privateKey), oid: PKCS8.x25519OID)
        do { return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) } catch {
            throw CoinfraCryptoError.invalidKey("X25519 private key")
        }
    }

    /// Import a base64url PKCS#8 Ed25519 private key once for reuse in `signChallenge`.
    public static func importSigningPrivateKey(_ privateKey: String) throws -> Curve25519.Signing.PrivateKey {
        let raw = try PKCS8.unwrap(try fromBase64url(privateKey), oid: PKCS8.ed25519OID)
        do { return try Curve25519.Signing.PrivateKey(rawRepresentation: raw) } catch {
            throw CoinfraCryptoError.invalidKey("Ed25519 private key")
        }
    }

    /// The PKCS#8 base64url form of an existing X25519 private key (e.g. one
    /// kept in the Keychain as raw bytes).
    public static func exportEncryptionPrivateKey(_ key: Curve25519.KeyAgreement.PrivateKey) -> String {
        base64url(PKCS8.x25519(key.rawRepresentation))
    }

    public static func exportSigningPrivateKey(_ key: Curve25519.Signing.PrivateKey) -> String {
        base64url(PKCS8.ed25519(key.rawRepresentation))
    }

    // MARK: Encrypt / decrypt

    public static func encrypt(_ plaintext: String, recipients: [Recipient]) throws -> Envelope {
        guard !recipients.isEmpty else { throw CoinfraCryptoError.noRecipients }
        let cek = SymmetricKey(size: .bits256)
        let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: cek, authenticating: contentAAD)
        var map: [String: RecipientEntry] = [:]
        var order: [String] = []
        for recipient in recipients {
            if map[recipient.recipientId] == nil { order.append(recipient.recipientId) }
            map[recipient.recipientId] = try wrap(cek, for: recipient)
        }
        return Envelope(
            v: envelopeVersion,
            suite: suiteName,
            iv: base64url(Data(sealed.nonce)),
            ciphertext: base64url(sealed.ciphertext + sealed.tag),
            recipients: map,
            recipientOrder: order
        )
    }

    public static func decrypt(_ envelope: Envelope, recipientId: String, privateKey: String) throws -> String {
        try decrypt(envelope, recipientId: recipientId, privateKey: try importEncryptionPrivateKey(privateKey))
    }

    public static func decrypt(
        _ envelope: Envelope,
        recipientId: String,
        privateKey: Curve25519.KeyAgreement.PrivateKey
    ) throws -> String {
        guard envelope.v == envelopeVersion else { throw CoinfraCryptoError.unsupportedVersion(envelope.v) }
        guard envelope.suite == suiteName else { throw CoinfraCryptoError.unsupportedSuite(-1) }
        guard let entry = envelope.recipients[recipientId] else {
            throw CoinfraCryptoError.noKeyForRecipient(recipientId)
        }
        let cek = try unwrap(entry, recipientId: recipientId, privateKey: privateKey)
        let payload = try fromBase64url(envelope.ciphertext)
        guard payload.count >= 16 else { throw CoinfraCryptoError.decryptionFailed }
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: try fromBase64url(envelope.iv)),
                ciphertext: payload.dropLast(16),
                tag: payload.suffix(16)
            )
            let plain = try AES.GCM.open(box, using: cek, authenticating: contentAAD)
            guard let text = String(data: plain, encoding: .utf8) else { throw CoinfraCryptoError.invalidUTF8 }
            return text
        } catch let error as CoinfraCryptoError {
            throw error
        } catch {
            throw CoinfraCryptoError.decryptionFailed
        }
    }

    public static func encryptToBlob(_ plaintext: String, recipients: [Recipient]) throws -> String {
        try serializeEnvelope(try encrypt(plaintext, recipients: recipients))
    }

    public static func decryptFromBlob(_ blob: String, recipientId: String, privateKey: String) throws -> String {
        try decrypt(try deserializeEnvelope(blob), recipientId: recipientId, privateKey: privateKey)
    }

    public static func decryptFromBlob(
        _ blob: String,
        recipientId: String,
        privateKey: Curve25519.KeyAgreement.PrivateKey
    ) throws -> String {
        try decrypt(try deserializeEnvelope(blob), recipientId: recipientId, privateKey: privateKey)
    }

    // MARK: Signing

    public static func signChallenge(_ nonce: String, privateKey: String) throws -> String {
        try signChallenge(nonce, privateKey: try importSigningPrivateKey(privateKey))
    }

    public static func signChallenge(_ nonce: String, privateKey: Curve25519.Signing.PrivateKey) throws -> String {
        base64url(try privateKey.signature(for: Data(challengeContext + Array(nonce.utf8))))
    }

    /// Never throws — false on any malformed input.
    public static func verifyChallenge(_ nonce: String, signature: String, publicKey: String) -> Bool {
        guard let raw = try? fromBase64url(publicKey),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw),
              let sig = try? fromBase64url(signature) else { return false }
        return key.isValidSignature(sig, for: Data(challengeContext + Array(nonce.utf8)))
    }

    // MARK: Key encapsulation

    static var contentAAD: Data { Data("\(suiteName)#\(envelopeVersion)".utf8) }

    static func kek(sharedSecret: SharedSecret, epk: Data) throws -> SymmetricKey {
        // A low-order peer key yields an all-zero secret; Web Crypto rejects
        // it, so must we.
        let isZero = sharedSecret.withUnsafeBytes { $0.allSatisfy { $0 == 0 } }
        guard !isZero else { throw CoinfraCryptoError.invalidKey("low-order X25519 public key") }
        return sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(),
            sharedInfo: Data(hkdfInfoLabel) + epk,
            outputByteCount: 32
        )
    }

    static func wrap(_ cek: SymmetricKey, for recipient: Recipient) throws -> RecipientEntry {
        let recipientKey: Curve25519.KeyAgreement.PublicKey
        do {
            recipientKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: try fromBase64url(recipient.publicKey))
        } catch {
            throw CoinfraCryptoError.invalidKey("recipient \(recipient.recipientId)")
        }
        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        let epk = ephemeral.publicKey.rawRepresentation
        let kek = try kek(sharedSecret: try ephemeral.sharedSecretFromKeyAgreement(with: recipientKey), epk: epk)
        let raw = cek.withUnsafeBytes { Data($0) }
        let sealed = try AES.GCM.seal(raw, using: kek, authenticating: epk + Data(recipient.recipientId.utf8))
        return RecipientEntry(
            epk: base64url(epk),
            key: base64url(Data(sealed.nonce) + sealed.ciphertext + sealed.tag)
        )
    }

    static func unwrap(
        _ entry: RecipientEntry,
        recipientId: String,
        privateKey: Curve25519.KeyAgreement.PrivateKey
    ) throws -> SymmetricKey {
        let epk = try fromBase64url(entry.epk)
        let raw = try fromBase64url(entry.key)
        guard raw.count >= ivSize + 16 else { throw CoinfraCryptoError.decryptionFailed }
        do {
            let ephemeralKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: epk)
            let kek = try kek(sharedSecret: try privateKey.sharedSecretFromKeyAgreement(with: ephemeralKey), epk: epk)
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: raw.prefix(ivSize)),
                ciphertext: raw.dropFirst(ivSize).dropLast(16),
                tag: raw.suffix(16)
            )
            let cek = try AES.GCM.open(box, using: kek, authenticating: epk + Data(recipientId.utf8))
            guard cek.count == cekSize else { throw CoinfraCryptoError.decryptionFailed }
            return SymmetricKey(data: cek)
        } catch let error as CoinfraCryptoError {
            throw error
        } catch {
            throw CoinfraCryptoError.decryptionFailed
        }
    }

    // MARK: Compact envelope

    public static func serializeEnvelope(_ envelope: Envelope) throws -> String {
        guard envelope.v == envelopeVersion, envelope.suite == suiteName else {
            throw CoinfraCryptoError.unsupportedVersion(envelope.v)
        }
        let iv = try fromBase64url(envelope.iv)
        let ciphertext = try fromBase64url(envelope.ciphertext)
        guard iv.count <= 0xff else { throw CoinfraCryptoError.fieldTooLarge("iv") }
        guard ciphertext.count <= 0xffff_ffff else { throw CoinfraCryptoError.fieldTooLarge("ciphertext") }
        let ids = envelope.recipientOrder.filter { envelope.recipients[$0] != nil }
            + envelope.recipients.keys.filter { !envelope.recipientOrder.contains($0) }.sorted()
        guard ids.count <= 0xffff else { throw CoinfraCryptoError.fieldTooLarge("recipients") }
        var out = Data(magic + [UInt8(envelopeVersion), suiteId])
        out.append(UInt8(iv.count)); out.append(iv)
        out.append(contentsOf: be32(UInt32(ciphertext.count))); out.append(ciphertext)
        out.append(contentsOf: be16(UInt16(ids.count)))
        for id in ids {
            guard let entry = envelope.recipients[id] else { continue }
            let idBytes = Data(id.utf8), epk = try fromBase64url(entry.epk), key = try fromBase64url(entry.key)
            guard idBytes.count <= 0xffff, epk.count <= 0xffff, key.count <= 0xffff else {
                throw CoinfraCryptoError.fieldTooLarge("recipient \(id)")
            }
            for field in [idBytes, epk, key] {
                out.append(contentsOf: be16(UInt16(field.count))); out.append(field)
            }
        }
        return base64url(out)
    }

    public static func deserializeEnvelope(_ blob: String) throws -> Envelope {
        let bytes = [UInt8](try fromBase64url(blob))
        var p = 0
        func need(_ n: Int) throws { if p + n > bytes.count { throw CoinfraCryptoError.truncatedEnvelope } }
        func take(_ n: Int) throws -> [UInt8] { try need(n); defer { p += n }; return Array(bytes[p..<p + n]) }
        func u16() throws -> Int { let b = try take(2); return Int(b[0]) << 8 | Int(b[1]) }
        try need(4)
        guard bytes[0] == magic[0], bytes[1] == magic[1] else { throw CoinfraCryptoError.notAnEnvelope }
        guard Int(bytes[2]) == envelopeVersion else { throw CoinfraCryptoError.unsupportedVersion(Int(bytes[2])) }
        guard bytes[3] == suiteId else { throw CoinfraCryptoError.unsupportedSuite(Int(bytes[3])) }
        p = 4
        let ivLen = Int(try take(1)[0])
        let iv = try take(ivLen)
        let ctLenBytes = try take(4)
        let ctLen = ctLenBytes.reduce(0) { $0 << 8 | Int($1) }
        let ct = try take(ctLen)
        let count = try u16()
        var recipients: [String: RecipientEntry] = [:]
        var order: [String] = []
        for _ in 0..<count {
            guard let id = String(bytes: try take(try u16()), encoding: .utf8) else { throw CoinfraCryptoError.invalidUTF8 }
            let epk = try take(try u16())
            let key = try take(try u16())
            if recipients[id] == nil { order.append(id) }
            recipients[id] = RecipientEntry(epk: base64url(Data(epk)), key: base64url(Data(key)))
        }
        return Envelope(
            v: envelopeVersion, suite: suiteName,
            iv: base64url(Data(iv)), ciphertext: base64url(Data(ct)),
            recipients: recipients, recipientOrder: order
        )
    }

    static func be16(_ n: UInt16) -> [UInt8] { [UInt8(n >> 8), UInt8(n & 0xff)] }
    static func be32(_ n: UInt32) -> [UInt8] { [UInt8(n >> 24), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)] }

    // MARK: base64url (unpadded, canonical — mirrors the TS codec)

    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func fromBase64url(_ text: String) throws -> Data {
        let rem = text.count % 4
        guard rem != 1 else { throw CoinfraCryptoError.invalidBase64url }
        guard text.utf8.allSatisfy({ c in
            (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 95
        }) else { throw CoinfraCryptoError.invalidBase64url }
        let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - rem) % 4)
        guard let data = Data(base64Encoded: padded) else { throw CoinfraCryptoError.invalidBase64url }
        // Reject non-canonical trailing bits, like the TS decoder.
        guard base64url(data) == text else { throw CoinfraCryptoError.nonCanonicalBase64url }
        return data
    }
}

/// Minimal PKCS#8 for the two fixed-size curve keys (RFC 8410).
enum PKCS8 {
    static let x25519OID: [UInt8] = [0x2b, 0x65, 0x6e]
    static let ed25519OID: [UInt8] = [0x2b, 0x65, 0x70]

    static func prefix(_ oid: [UInt8]) -> [UInt8] {
        [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03] + oid + [0x04, 0x22, 0x04, 0x20]
    }

    static func x25519(_ raw: Data) -> Data { Data(prefix(x25519OID)) + raw }
    static func ed25519(_ raw: Data) -> Data { Data(prefix(ed25519OID)) + raw }

    static func unwrap(_ der: Data, oid: [UInt8]) throws -> Data {
        let head = prefix(oid)
        guard der.count == head.count + 32, Array(der.prefix(head.count)) == head else {
            throw CoinfraCryptoError.invalidKey("PKCS#8")
        }
        return der.suffix(32)
    }
}
