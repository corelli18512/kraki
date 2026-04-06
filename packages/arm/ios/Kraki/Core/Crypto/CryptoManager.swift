/// CryptoManager — Kraki E2E encryption module.
///
/// Hybrid encryption: AES-256-GCM for payload, RSA-OAEP for key wrapping.
/// Ported from the proven spike at KrakiSpikeTests/Sources/KrakiCrypto.

import Foundation
import Security
import CryptoKit

// MARK: - Types

/// Crypto-layer blob payload. Use `toCryptoBlobPayload()` / init conversions
/// when bridging with the Protocol-layer `BlobPayload`.
public struct CryptoBlobPayload: Codable, Sendable {
    /// base64(iv ‖ ciphertext ‖ tag)
    public let blob: String
    /// deviceId → base64(RSA-wrapped AES key)
    public let keys: [String: String]

    public init(blob: String, keys: [String: String]) {
        self.blob = blob
        self.keys = keys
    }
}

public struct RecipientKey {
    public let deviceId: String
    public let publicKey: SecKey

    public init(deviceId: String, publicKey: SecKey) {
        self.deviceId = deviceId
        self.publicKey = publicKey
    }
}

public enum CryptoError: Error, CustomStringConvertible {
    case keyGenerationFailed(String)
    case keyImportFailed(String)
    case keyExportFailed(String)
    case encryptionFailed(String)
    case decryptionFailed(String)
    case signingFailed(String)
    case noKeyForDevice(String)
    case invalidData(String)

    public var description: String {
        switch self {
        case .keyGenerationFailed(let msg): return "Key generation failed: \(msg)"
        case .keyImportFailed(let msg):     return "Key import failed: \(msg)"
        case .keyExportFailed(let msg):     return "Key export failed: \(msg)"
        case .encryptionFailed(let msg):    return "Encryption failed: \(msg)"
        case .decryptionFailed(let msg):    return "Decryption failed: \(msg)"
        case .signingFailed(let msg):       return "Signing failed: \(msg)"
        case .noKeyForDevice(let id):       return "No key for device: \(id)"
        case .invalidData(let msg):         return "Invalid data: \(msg)"
        }
    }
}

// MARK: - CryptoManager

public final class CryptoManager {

    public init() {}

    // MARK: - Key Generation

    /// Generate an RSA-4096 key pair.
    public func generateKeyPair() throws -> (privateKey: SecKey, publicKey: SecKey) {
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits as String: 4096,
        ]
        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
            throw CryptoError.keyGenerationFailed(
                error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
            )
        }
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw CryptoError.keyGenerationFailed("Cannot extract public key")
        }
        return (privateKey: privateKey, publicKey: publicKey)
    }

    // MARK: - SPKI Export / Import

    /// Export a public key as SPKI DER base64 (compatible with Node.js `importPublicKey`).
    public func exportPublicKeySPKI(_ key: SecKey) throws -> String {
        var error: Unmanaged<CFError>?
        guard let rawData = SecKeyCopyExternalRepresentation(key, &error) as Data? else {
            throw CryptoError.keyExportFailed(
                error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
            )
        }
        // SecKeyCopyExternalRepresentation returns PKCS#1 for RSA public keys.
        // Node.js expects SPKI format, so we wrap it.
        let spki = Self.wrapInSPKI(pkcs1PublicKey: rawData)
        return spki.base64EncodedString()
    }

    /// Import a public key from SPKI DER base64 (as received from the server / other devices).
    public func importPublicKeyFromSPKI(_ base64: String) throws -> SecKey {
        guard let der = Data(base64Encoded: base64) else {
            throw CryptoError.keyImportFailed("Invalid base64")
        }
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits as String: 4096,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(der as CFData, attrs as CFDictionary, &error) else {
            throw CryptoError.keyImportFailed(
                error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
            )
        }
        return key
    }

    /// Import a private key from a PKCS#8 PEM string.
    public func importPrivateKeyFromPEM(_ pem: String) throws -> SecKey {
        let stripped = pem
            .replacingOccurrences(of: "-----BEGIN PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "-----END PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "-----BEGIN RSA PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "-----END RSA PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .trimmingCharacters(in: .whitespaces)

        guard let der = Data(base64Encoded: stripped) else {
            throw CryptoError.keyImportFailed("Invalid PEM base64")
        }

        let keyData = Self.stripPKCS8Header(der) ?? der

        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrKeySizeInBits as String: 4096,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(keyData as CFData, attrs as CFDictionary, &error) else {
            throw CryptoError.keyImportFailed(
                error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
            )
        }
        return key
    }

    // MARK: - Encryption

    /// Encrypt a plaintext string for multiple recipients.
    public func encryptToBlob(_ plaintext: String, recipients: [RecipientKey]) throws -> CryptoBlobPayload {
        guard !recipients.isEmpty else {
            throw CryptoError.encryptionFailed("At least one recipient required")
        }
        guard let plaintextData = plaintext.data(using: .utf8) else {
            throw CryptoError.encryptionFailed("Cannot encode plaintext as UTF-8")
        }

        // 1. Generate random AES-256 key + 96-bit IV
        var aesKeyBytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, 32, &aesKeyBytes) == errSecSuccess else {
            throw CryptoError.encryptionFailed("Random generation failed")
        }
        var ivBytes = [UInt8](repeating: 0, count: 12)
        guard SecRandomCopyBytes(kSecRandomDefault, 12, &ivBytes) == errSecSuccess else {
            throw CryptoError.encryptionFailed("IV generation failed")
        }

        // 2. Encrypt with AES-256-GCM
        let symmetricKey = SymmetricKey(data: Data(aesKeyBytes))
        let nonce = try AES.GCM.Nonce(data: Data(ivBytes))
        let sealed = try AES.GCM.seal(plaintextData, using: symmetricKey, nonce: nonce)

        // 3. Build blob: iv + ciphertext + tag
        var blobData = Data()
        blobData.append(Data(ivBytes))
        blobData.append(sealed.ciphertext)
        blobData.append(sealed.tag)

        // 4. Wrap AES key for each recipient via RSA-OAEP
        var keys: [String: String] = [:]
        for recipient in recipients {
            var error: Unmanaged<CFError>?
            guard let wrapped = SecKeyCreateEncryptedData(
                recipient.publicKey,
                .rsaEncryptionOAEPSHA256,
                Data(aesKeyBytes) as CFData,
                &error
            ) as Data? else {
                throw CryptoError.encryptionFailed(
                    "Key wrap failed for \(recipient.deviceId): " +
                    (error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown")
                )
            }
            keys[recipient.deviceId] = wrapped.base64EncodedString()
        }

        return CryptoBlobPayload(blob: blobData.base64EncodedString(), keys: keys)
    }

    /// Decrypt a blob payload intended for this device.
    public func decryptFromBlob(_ payload: CryptoBlobPayload, deviceId: String, privateKey: SecKey) throws -> String {
        guard let wrappedKeyB64 = payload.keys[deviceId] else {
            throw CryptoError.noKeyForDevice(deviceId)
        }
        guard let wrappedKey = Data(base64Encoded: wrappedKeyB64) else {
            throw CryptoError.invalidData("Invalid wrapped key base64")
        }
        guard let blobData = Data(base64Encoded: payload.blob) else {
            throw CryptoError.invalidData("Invalid blob base64")
        }
        // 12 (iv) + 0 (min ct) + 16 (tag) = 28 minimum
        guard blobData.count > 28 else {
            throw CryptoError.invalidData("Blob too short: \(blobData.count) bytes")
        }

        // 1. Unwrap AES key
        var error: Unmanaged<CFError>?
        guard let aesKeyData = SecKeyCreateDecryptedData(
            privateKey,
            .rsaEncryptionOAEPSHA256,
            wrappedKey as CFData,
            &error
        ) as Data? else {
            throw CryptoError.decryptionFailed(
                "Key unwrap failed: " +
                (error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown")
            )
        }

        // 2. Parse blob: iv[0..12] + ciphertext[12..n-16] + tag[n-16..n]
        let iv = blobData[0..<12]
        let ciphertext = blobData[12..<(blobData.count - 16)]
        let tag = blobData[(blobData.count - 16)...]

        // 3. Decrypt with AES-256-GCM
        let symmetricKey = SymmetricKey(data: aesKeyData)
        let nonce = try AES.GCM.Nonce(data: iv)
        let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        let plainData = try AES.GCM.open(sealedBox, using: symmetricKey)

        guard let plaintext = String(data: plainData, encoding: .utf8) else {
            throw CryptoError.decryptionFailed("Cannot decode plaintext as UTF-8")
        }
        return plaintext
    }

    // MARK: - Challenge-Response Signing

    /// Sign a nonce string for challenge-response auth (RSASSA-PKCS1-v1_5 with SHA-256).
    public func signChallenge(_ nonce: String, privateKey: SecKey) throws -> String {
        guard let data = nonce.data(using: .utf8) else {
            throw CryptoError.signingFailed("Cannot encode nonce as UTF-8")
        }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
            privateKey,
            .rsaSignatureMessagePKCS1v15SHA256,
            data as CFData,
            &error
        ) as Data? else {
            throw CryptoError.signingFailed(
                error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
            )
        }
        return signature.base64EncodedString()
    }

    /// Verify a challenge signature.
    public func verifyChallenge(_ nonce: String, signature: String, publicKey: SecKey) -> Bool {
        guard let data = nonce.data(using: .utf8),
              let sigData = Data(base64Encoded: signature) else {
            return false
        }
        var error: Unmanaged<CFError>?
        return SecKeyVerifySignature(
            publicKey, .rsaSignatureMessagePKCS1v15SHA256,
            data as CFData, sigData as CFData, &error
        )
    }

    // MARK: - ASN.1 Helpers

    /// Wraps a PKCS#1 RSA public key in SPKI ASN.1 structure.
    static func wrapInSPKI(pkcs1PublicKey: Data) -> Data {
        // RSA algorithm OID (1.2.840.113549.1.1.1) with NULL params
        let algorithmIdentifier: [UInt8] = [
            0x30, 0x0D,
            0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D,
            0x01, 0x01, 0x01,
            0x05, 0x00,
        ]
        let bitStringContent = [UInt8(0x00)] + [UInt8](pkcs1PublicKey)
        let bitString = [UInt8(0x03)] + asn1Length(bitStringContent.count) + bitStringContent
        let innerContent = algorithmIdentifier + bitString
        let spki = [UInt8(0x30)] + asn1Length(innerContent.count) + innerContent
        return Data(spki)
    }

    /// Strip PKCS#8 wrapper to extract inner PKCS#1 private key.
    static func stripPKCS8Header(_ pkcs8: Data) -> Data? {
        let bytes = [UInt8](pkcs8)
        guard bytes.count > 26, bytes[0] == 0x30 else { return nil }

        var idx = 1
        idx = skipASN1Length(bytes, idx)

        // Version INTEGER
        guard idx < bytes.count, bytes[idx] == 0x02 else { return nil }
        idx += 1
        let vLen = readASN1Length(bytes, &idx)
        idx += vLen

        // AlgorithmIdentifier SEQUENCE
        guard idx < bytes.count, bytes[idx] == 0x30 else { return nil }
        idx += 1
        let aLen = readASN1Length(bytes, &idx)
        idx += aLen

        // PrivateKey OCTET STRING
        guard idx < bytes.count, bytes[idx] == 0x04 else { return nil }
        idx += 1
        let kLen = readASN1Length(bytes, &idx)
        guard idx + kLen <= bytes.count else { return nil }

        return Data(bytes[idx..<(idx + kLen)])
    }

    private static func asn1Length(_ length: Int) -> [UInt8] {
        if length < 0x80 { return [UInt8(length)] }
        if length < 0x100 { return [0x81, UInt8(length)] }
        if length < 0x10000 { return [0x82, UInt8(length >> 8), UInt8(length & 0xFF)] }
        return [0x83, UInt8(length >> 16), UInt8((length >> 8) & 0xFF), UInt8(length & 0xFF)]
    }

    private static func skipASN1Length(_ bytes: [UInt8], _ idx: Int) -> Int {
        var i = idx
        _ = readASN1Length(bytes, &i)
        return i
    }

    private static func readASN1Length(_ bytes: [UInt8], _ idx: inout Int) -> Int {
        guard idx < bytes.count else { return 0 }
        let first = bytes[idx]; idx += 1
        if first < 0x80 { return Int(first) }
        let n = Int(first & 0x7F)
        var length = 0
        for _ in 0..<n {
            guard idx < bytes.count else { return 0 }
            length = (length << 8) | Int(bytes[idx]); idx += 1
        }
        return length
    }
}
