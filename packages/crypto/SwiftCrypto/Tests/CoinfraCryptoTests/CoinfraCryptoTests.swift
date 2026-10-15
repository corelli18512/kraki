import CryptoKit
import Foundation
import XCTest
@testable import CoinfraCrypto

final class CoinfraCryptoTests: XCTestCase {
    typealias C = CoinfraCrypto

    // MARK: Round trips

    func testEncryptDecryptManyRecipients() throws {
        let a = C.generateEncryptionKeyPair(), b = C.generateEncryptionKeyPair()
        for text in ["", "hello", "好的，我来看一下。🐙", String(repeating: "x", count: 70_000)] {
            let blob = try C.encryptToBlob(text, recipients: [
                .init(recipientId: "a", publicKey: a.publicKey), .init(recipientId: "b", publicKey: b.publicKey),
            ])
            XCTAssertEqual(try C.decryptFromBlob(blob, recipientId: "a", privateKey: a.privateKey), text)
            XCTAssertEqual(try C.decryptFromBlob(blob, recipientId: "b", privateKey: b.privateKey), text)
        }
    }

    func testImportedKeyHandleIsReusable() throws {
        let kp = C.generateEncryptionKeyPair()
        let key = try C.importEncryptionPrivateKey(kp.privateKey)
        XCTAssertEqual(C.exportEncryptionPrivateKey(key), kp.privateKey)
        let blob = try C.encryptToBlob("x", recipients: [.init(recipientId: "r", publicKey: kp.publicKey)])
        XCTAssertEqual(try C.decryptFromBlob(blob, recipientId: "r", privateKey: key), "x")
    }

    func testSignVerify() throws {
        let kp = C.generateSigningKeyPair()
        let sig = try C.signChallenge("n1", privateKey: kp.privateKey)
        XCTAssertTrue(C.verifyChallenge("n1", signature: sig, publicKey: kp.publicKey))
        XCTAssertFalse(C.verifyChallenge("n2", signature: sig, publicKey: kp.publicKey))
        XCTAssertFalse(C.verifyChallenge("n1", signature: "not!b64", publicKey: kp.publicKey))
        XCTAssertFalse(C.verifyChallenge("n1", signature: sig, publicKey: C.generateSigningKeyPair().publicKey))
    }

    // MARK: Tamper / misuse

    func testWrongRecipientAndWrongKeyFail() throws {
        let a = C.generateEncryptionKeyPair(), other = C.generateEncryptionKeyPair()
        let blob = try C.encryptToBlob("s", recipients: [.init(recipientId: "a", publicKey: a.publicKey)])
        XCTAssertThrowsError(try C.decryptFromBlob(blob, recipientId: "b", privateKey: a.privateKey))
        XCTAssertThrowsError(try C.decryptFromBlob(blob, recipientId: "a", privateKey: other.privateKey))
    }

    /// A wrapped key moved to another recipient id fails (id is bound in AAD).
    func testRecipientIdIsAuthenticated() throws {
        let a = C.generateEncryptionKeyPair()
        let env = try C.encrypt("s", recipients: [.init(recipientId: "a", publicKey: a.publicKey)])
        let moved = C.Envelope(v: env.v, suite: env.suite, iv: env.iv, ciphertext: env.ciphertext,
                               recipients: ["b": env.recipients["a"]!], recipientOrder: ["b"])
        XCTAssertThrowsError(try C.decrypt(moved, recipientId: "b", privateKey: a.privateKey))
    }

    func testTamperedBytesFail() throws {
        let a = C.generateEncryptionKeyPair()
        let blob = try C.encryptToBlob("secret", recipients: [.init(recipientId: "a", publicKey: a.publicKey)])
        var bytes = [UInt8](try C.fromBase64url(blob))
        for index in [8, 12, bytes.count - 1] {
            var copy = bytes
            copy[index] ^= 0x01
            XCTAssertThrowsError(try C.decryptFromBlob(C.base64url(Data(copy)), recipientId: "a", privateKey: a.privateKey))
        }
        bytes[2] = 9
        XCTAssertThrowsError(try C.deserializeEnvelope(C.base64url(Data(bytes)))) {
            XCTAssertEqual($0 as? CoinfraCryptoError, .unsupportedVersion(9))
        }
        XCTAssertThrowsError(try C.deserializeEnvelope(String(blob.prefix(20))))
    }

    func testCanonicalBase64url() {
        XCTAssertThrowsError(try C.fromBase64url("QR")) { XCTAssertEqual($0 as? CoinfraCryptoError, .nonCanonicalBase64url) }
        XCTAssertThrowsError(try C.fromBase64url("Q===")) { XCTAssertEqual($0 as? CoinfraCryptoError, .invalidBase64url) }
        XCTAssertEqual(try C.fromBase64url("QQ"), Data([0x41]))
    }

    func testLowOrderRecipientKeyRejected() {
        let zero = C.base64url(Data(count: 32))
        XCTAssertThrowsError(try C.encrypt("x", recipients: [.init(recipientId: "z", publicKey: zero)]))
    }

    // MARK: Interop with TypeScript

    private func fixture(_ name: String) throws -> [String: Any] {
        // Shared with Node and Web Crypto tests: one canonical fixture set.
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("src/__tests__/fixtures/\(name).json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    /// Blobs/signatures produced by the TS (Web Crypto) implementation.
    func testOpensTypeScriptVectors() throws {
        let v = try fixture("ts-vectors")
        let recipients = try XCTUnwrap(v["recipients"] as? [[String: String]])
        for blob in try XCTUnwrap(v["blobs"] as? [[String: String]]) {
            for r in recipients {
                XCTAssertEqual(try C.decryptFromBlob(blob["blob"]!, recipientId: r["recipientId"]!,
                                                     privateKey: r["privateKey"]!), blob["plaintext"]!)
            }
            let env = try C.deserializeEnvelope(blob["blob"]!)
            XCTAssertEqual(try C.serializeEnvelope(env), blob["blob"], "re-serialization is byte-identical")
        }
        let s = try XCTUnwrap(v["signing"] as? [String: String])
        XCTAssertTrue(C.verifyChallenge(s["nonce"]!, signature: s["signature"]!, publicKey: s["publicKey"]!))
        // Swift signs with the TS-generated private key; TS keys import cleanly.
        let swiftSig = try C.signChallenge("again", privateKey: s["privateKey"]!)
        XCTAssertTrue(C.verifyChallenge("again", signature: swiftSig, publicKey: s["publicKey"]!))
    }

    /// Writes swift-vectors.json for the TS test (`COINFRA_WRITE_SWIFT_VECTORS=<path>`).
    func testWriteSwiftVectors() throws {
        guard let path = ProcessInfo.processInfo.environment["COINFRA_WRITE_SWIFT_VECTORS"] else {
            throw XCTSkip("set COINFRA_WRITE_SWIFT_VECTORS to regenerate")
        }
        let enc = [C.generateEncryptionKeyPair(), C.generateEncryptionKeyPair()]
        let sig = C.generateSigningKeyPair()
        let recipients = [("dev_alpha", enc[0]), ("dev_beta", enc[1])]
        var blobs: [[String: String]] = []
        for text in ["", "hello", "好的，我来看一下这个问题。🐙", String(repeating: "y", count: 70_000)] {
            let blob = try C.encryptToBlob(text, recipients: recipients.map { .init(recipientId: $0.0, publicKey: $0.1.publicKey) })
            blobs.append(["plaintext": text, "blob": blob])
        }
        let out: [String: Any] = [
            "generator": "CoinfraCrypto (Swift, CryptoKit)",
            "recipients": recipients.map { ["recipientId": $0.0, "publicKey": $0.1.publicKey, "privateKey": $0.1.privateKey] },
            "blobs": blobs,
            "signing": ["publicKey": sig.publicKey, "privateKey": sig.privateKey, "nonce": "nonce-swift-1234",
                        "signature": try C.signChallenge("nonce-swift-1234", privateKey: sig.privateKey)],
        ]
        try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: path))
    }

    // MARK: Cost (informational)

    func testDecryptCost() throws {
        let kp = C.generateEncryptionKeyPair()
        let key = try C.importEncryptionPrivateKey(kp.privateKey)
        let blob = try C.encryptToBlob(String(repeating: "好", count: 500), recipients: [.init(recipientId: "r", publicKey: kp.publicKey)])
        let t = CFAbsoluteTimeGetCurrent()
        for _ in 0..<200 { _ = try C.decryptFromBlob(blob, recipientId: "r", privateKey: key) }
        let ms = (CFAbsoluteTimeGetCurrent() - t) * 1000 / 200
        print("COINFRA-SWIFT decrypt \(ms) ms/message")
        XCTAssertLessThan(ms, 2)
    }
}
