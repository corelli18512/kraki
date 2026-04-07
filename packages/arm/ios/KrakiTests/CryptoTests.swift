import XCTest
@testable import Kraki

final class CryptoTests: XCTestCase {

    private let crypto = CryptoManager()

    // Key generation is slow (~2s for RSA-4096). Generate once per class.
    private static var sharedKeyPair: (privateKey: SecKey, publicKey: SecKey)!

    override class func setUp() {
        super.setUp()
        sharedKeyPair = try! CryptoManager().generateKeyPair()
    }

    private var privateKey: SecKey { Self.sharedKeyPair.privateKey }
    private var publicKey: SecKey { Self.sharedKeyPair.publicKey }

    // MARK: - Key Generation

    func testGenerateKeyPair() throws {
        let (priv, pub) = try crypto.generateKeyPair()
        XCTAssertNotNil(priv)
        XCTAssertNotNil(pub)
        // Verify key size by exporting
        let spki = try crypto.exportPublicKeySPKI(pub)
        XCTAssertFalse(spki.isEmpty)
    }

    // MARK: - SPKI Export / Import

    func testExportImportSPKIRoundtrip() throws {
        let exported = try crypto.exportPublicKeySPKI(publicKey)
        XCTAssertFalse(exported.isEmpty)

        let imported = try crypto.importPublicKeyFromSPKI(exported)
        // Verify by exporting the imported key — should match
        let reExported = try crypto.exportPublicKeySPKI(imported)
        XCTAssertEqual(exported, reExported)
    }

    // MARK: - Encrypt / Decrypt

    func testEncryptDecryptRoundtrip() throws {
        let plaintext = "Hello, World! 🌍"
        let recipient = RecipientKey(deviceId: "my-device", publicKey: publicKey)
        let blob = try crypto.encryptToBlob(plaintext, recipients: [recipient])

        XCTAssertFalse(blob.blob.isEmpty)
        XCTAssertEqual(blob.keys.count, 1)
        XCTAssertNotNil(blob.keys["my-device"])

        let decrypted = try crypto.decryptFromBlob(blob, deviceId: "my-device", privateKey: privateKey)
        XCTAssertEqual(decrypted, plaintext)
    }

    func testMultiRecipientEncrypt() throws {
        let (priv2, pub2) = try crypto.generateKeyPair()
        let plaintext = "Secret for two recipients"
        let recipients = [
            RecipientKey(deviceId: "device-A", publicKey: publicKey),
            RecipientKey(deviceId: "device-B", publicKey: pub2),
        ]
        let blob = try crypto.encryptToBlob(plaintext, recipients: recipients)
        XCTAssertEqual(blob.keys.count, 2)

        let decrypted1 = try crypto.decryptFromBlob(blob, deviceId: "device-A", privateKey: privateKey)
        XCTAssertEqual(decrypted1, plaintext)

        let decrypted2 = try crypto.decryptFromBlob(blob, deviceId: "device-B", privateKey: priv2)
        XCTAssertEqual(decrypted2, plaintext)
    }

    func testDecryptWithWrongKeyFails() throws {
        let plaintext = "Confidential"
        let recipient = RecipientKey(deviceId: "dev-1", publicKey: publicKey)
        let blob = try crypto.encryptToBlob(plaintext, recipients: [recipient])

        let (wrongPriv, _) = try crypto.generateKeyPair()
        XCTAssertThrowsError(
            try crypto.decryptFromBlob(blob, deviceId: "dev-1", privateKey: wrongPriv)
        )
    }

    func testDecryptWithWrongDeviceIdFails() throws {
        let plaintext = "Secret"
        let recipient = RecipientKey(deviceId: "dev-1", publicKey: publicKey)
        let blob = try crypto.encryptToBlob(plaintext, recipients: [recipient])

        XCTAssertThrowsError(
            try crypto.decryptFromBlob(blob, deviceId: "wrong-device", privateKey: privateKey)
        ) { error in
            if case CryptoError.noKeyForDevice(let id) = error {
                XCTAssertEqual(id, "wrong-device")
            } else {
                XCTFail("Expected noKeyForDevice error, got \(error)")
            }
        }
    }

    func testEncryptRequiresAtLeastOneRecipient() {
        XCTAssertThrowsError(
            try crypto.encryptToBlob("test", recipients: [])
        )
    }

    // MARK: - Challenge Signing

    func testSignVerifyChallengeRoundtrip() throws {
        let nonce = "random-nonce-\(UUID().uuidString)"
        let signature = try crypto.signChallenge(nonce, privateKey: privateKey)
        XCTAssertFalse(signature.isEmpty)

        let verified = crypto.verifyChallenge(nonce, signature: signature, publicKey: publicKey)
        XCTAssertTrue(verified)
    }

    func testVerifyWithWrongNonceFails() throws {
        let signature = try crypto.signChallenge("correct-nonce", privateKey: privateKey)
        let verified = crypto.verifyChallenge("wrong-nonce", signature: signature, publicKey: publicKey)
        XCTAssertFalse(verified)
    }

    func testVerifyWithWrongKeyFails() throws {
        let nonce = "test-nonce"
        let signature = try crypto.signChallenge(nonce, privateKey: privateKey)

        let (_, wrongPub) = try crypto.generateKeyPair()
        let verified = crypto.verifyChallenge(nonce, signature: signature, publicKey: wrongPub)
        XCTAssertFalse(verified)
    }

    // MARK: - Large Payload

    func testLargePayload() throws {
        let plaintext = String(repeating: "A", count: 50_000)
        let recipient = RecipientKey(deviceId: "dev-1", publicKey: publicKey)
        let blob = try crypto.encryptToBlob(plaintext, recipients: [recipient])
        let decrypted = try crypto.decryptFromBlob(blob, deviceId: "dev-1", privateKey: privateKey)
        XCTAssertEqual(decrypted, plaintext)
        XCTAssertEqual(decrypted.count, 50_000)
    }

    // MARK: - Blob Format

    func testBlobFormat() throws {
        let plaintext = "test"
        let recipient = RecipientKey(deviceId: "dev-1", publicKey: publicKey)
        let blob = try crypto.encryptToBlob(plaintext, recipients: [recipient])

        let blobData = try XCTUnwrap(Data(base64Encoded: blob.blob))
        // iv(12) + ciphertext(>=1) + tag(16) = at least 29 bytes
        XCTAssertGreaterThanOrEqual(blobData.count, 29)

        // First 12 bytes = IV, last 16 bytes = tag
        let iv = blobData[0..<12]
        let tag = blobData[(blobData.count - 16)...]
        XCTAssertEqual(iv.count, 12)
        XCTAssertEqual(tag.count, 16)
    }

    // MARK: - CryptoBlobPayload Codable

    func testCryptoBlobPayloadCodable() throws {
        let payload = CryptoBlobPayload(blob: "blobdata", keys: ["dev-1": "key1"])
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(CryptoBlobPayload.self, from: data)
        XCTAssertEqual(decoded.blob, "blobdata")
        XCTAssertEqual(decoded.keys["dev-1"], "key1")
    }
}
