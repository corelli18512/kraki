import CryptoKit
import Foundation
import XCTest
@testable import Kraki_Dev

/// The CLI-login (process-local) keys use macOS's modern SecKey
/// implementation: same RSA-4096/OAEP/PKCS#1 wire format, much cheaper decrypt.
final class MacProcessLocalKeyTests: XCTestCase {
    private let crypto = CryptoManager()

    private func roundTrip(_ pair: (privateKey: SecKey, publicKey: SecKey)) throws {
        // Export → import as the Tentacle/Head would see it (SPKI), encrypt to
        // it, decrypt with the private key.
        let spki = try crypto.exportPublicKeySPKI(pair.publicKey)
        let imported = try crypto.importPublicKeyFromSPKI(spki)
        let text = String(repeating: "\u{597D}\u{7684}\u{FF0C}\u{6211}\u{6765}\u{770B}\u{4E00}\u{4E0B}\u{3002}abc ", count: 80)
        let payload = try crypto.encryptToBlob(text, recipients: [.init(deviceId: "me", publicKey: imported)])
        XCTAssertEqual(try crypto.decryptFromBlob(payload, deviceId: "me", privateKey: pair.privateKey), text)
        let signature = try crypto.signChallenge("nonce-123", privateKey: pair.privateKey)
        XCTAssertTrue(crypto.verifyChallenge("nonce-123", signature: signature, publicKey: imported))
    }

    func testProcessLocalKeysKeepTheWireFormat() throws {
        try roundTrip(try KeychainManager.makeProcessLocalKeyPair())
    }

    /// Ciphertext and signatures cross between old and new implementations, so
    /// mixed versions (and Tentacle's Node OAEP-SHA256) interoperate.
    func testModernAndLegacyKeysInteroperate() throws {
        let modern = try KeychainManager.makeProcessLocalKeyPair()
        let legacy = try KeychainManager.makeLegacyProcessLocalKeyPairForTesting()
        let attrs = SecKeyCopyAttributes(modern.publicKey) as? [String: Any]
        XCTAssertEqual(attrs?[kSecAttrKeySizeInBits as String] as? Int, 4096)
        // Legacy-side encrypt to the modern key, and vice versa.
        let toModern = try crypto.encryptToBlob("x", recipients: [.init(deviceId: "m", publicKey: modern.publicKey)])
        XCTAssertEqual(try crypto.decryptFromBlob(toModern, deviceId: "m", privateKey: modern.privateKey), "x")
        let toLegacy = try crypto.encryptToBlob("y", recipients: [.init(deviceId: "l", publicKey: legacy.publicKey)])
        XCTAssertEqual(try crypto.decryptFromBlob(toLegacy, deviceId: "l", privateKey: legacy.privateKey), "y")
        let sig = try crypto.signChallenge("n", privateKey: modern.privateKey)
        let spki = try crypto.exportPublicKeySPKI(modern.publicKey)
        XCTAssertTrue(crypto.verifyChallenge("n", signature: sig, publicKey: try crypto.importPublicKeyFromSPKI(spki)))
    }

    /// The point of the change: inbound decrypt is several times cheaper.
    func testProcessLocalDecryptIsFasterThanLegacy() throws {
        let modern = try KeychainManager.makeProcessLocalKeyPair()
        let legacy = try KeychainManager.makeLegacyProcessLocalKeyPairForTesting()
        func perMessageMs(_ pair: (privateKey: SecKey, publicKey: SecKey)) throws -> Double {
            let p = try crypto.encryptToBlob("hello", recipients: [.init(deviceId: "d", publicKey: pair.publicKey)])
            _ = try crypto.decryptFromBlob(p, deviceId: "d", privateKey: pair.privateKey)
            let t = CFAbsoluteTimeGetCurrent()
            for _ in 0..<20 { _ = try crypto.decryptFromBlob(p, deviceId: "d", privateKey: pair.privateKey) }
            return (CFAbsoluteTimeGetCurrent() - t) * 1000 / 20
        }
        let modernMs = try perMessageMs(modern), legacyMs = try perMessageMs(legacy)
        print("PROCESS-LOCAL-KEY decrypt modern=\(modernMs)ms legacy=\(legacyMs)ms")
        XCTAssertLessThan(modernMs * 2.5, legacyMs, "modern SecKey decrypt is several times cheaper")
    }

    /// Production wiring: activating ephemeral keys hands out the modern pair.
    func testEphemeralKeychainPathUsesProcessLocalKeys() throws {
        let keychain = KeychainManager()
        keychain.activateEphemeralKeys()
        defer { try? keychain.deleteAllKeys() }
        let pair = try keychain.getOrCreateEncryptionKey()
        XCTAssertTrue(keychain.usingEphemeralKeys)
        try roundTrip(pair)
        XCTAssertEqual(pair.privateKey, try keychain.getOrCreateEncryptionKey().privateKey, "cached per process")
    }
}
