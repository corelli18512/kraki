import Foundation
import XCTest
@testable import Kraki_Dev

/// Debug builds of the Mac app (often ad-hoc signed by agents and test runs)
/// must not touch anything macOS guards with a prompt: the login keychain and
/// the user's Documents folder.
final class MacDebugPromptFreeTests: XCTestCase {

    // MARK: Diagnostic files

    func testDiagnosticFilesStayOutOfDocuments() {
        let dir = KrakiDiagnosticFiles.directory.standardizedFileURL.path
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .standardizedFileURL.path
        XCTAssertFalse(dir.hasPrefix(documents), dir)
        XCTAssertTrue(dir.contains("/Library/Logs/"), dir)
        XCTAssertEqual(KrakiDiagnosticFiles.url("chat-entry.log").deletingLastPathComponent().path,
                       KrakiDiagnosticFiles.directory.path)
    }

    // MARK: Identity keys

    func testDebugIdentityKeysPersistInFilesNotTheKeychain() throws {
        XCTAssertTrue(DevSecretFileStore.isEnabled)
        let manager = KeychainManager()
        try manager.deleteAllKeys()
        defer { try? KeychainManager().deleteAllKeys() }

        let first = try manager.getOrCreateSigningKey()
        XCTAssertFalse(manager.usingEphemeralKeys)
        let files = try FileManager.default.contentsOfDirectory(atPath: DevSecretFileStore.directory.path)
        XCTAssertTrue(files.contains { $0.hasSuffix("signing-key") }, "\(files)")
        let attrs = try FileManager.default.attributesOfItem(
            atPath: DevSecretFileStore.directory.appendingPathComponent(files.first { $0.hasSuffix("signing-key") }!).path
        )
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        // A fresh manager (a relaunch) loads the same key from the file.
        let crypto = CryptoManager()
        let again = try KeychainManager().getOrCreateSigningKey()
        XCTAssertEqual(try crypto.exportPublicKeySPKI(first.publicKey),
                       try crypto.exportPublicKeySPKI(again.publicKey))
        let signature = try crypto.signChallenge("nonce", privateKey: again.privateKey)
        XCTAssertTrue(crypto.verifyChallenge("nonce", signature: signature, publicKey: first.publicKey))

        let encryption = try KeychainManager().getOrCreateEncryptionKey()
        let blob = try crypto.encryptToBlob("hi", recipients: [.init(deviceId: "d", publicKey: encryption.publicKey)])
        let reloaded = try KeychainManager().getOrCreateEncryptionKey()
        XCTAssertEqual(try crypto.decryptFromBlob(blob, deviceId: "d", privateKey: reloaded.privateKey), "hi")

        try KeychainManager().deleteAllKeys()
        XCTAssertFalse(KeychainManager().hasKeys())
    }

    // MARK: Voice lease

    func testVoiceLeaseServiceIsPerAppOutsideProduction() {
        // The test host is a Dev/test-scope bundle, never the production one.
        XCTAssertNotEqual(KeychainVoiceLeaseStore.service, "chat.kraki.voice-lease")
        XCTAssertTrue(KeychainVoiceLeaseStore.service.hasPrefix("chat.kraki.voice-lease."))
    }

    func testDebugVoiceLeaseRoundTripsThroughAFile() throws {
        let store = KeychainVoiceLeaseStore()
        store.clear()
        defer { store.clear() }
        XCTAssertNil(store.load())

        let lease = StoredVoiceLease(
            lease: VoiceLease(
                payload: VoiceLeasePayload(ver: 1, iss: "head", sub: "u", did: "d", iat: 1, exp: 2,
                                           quotaSeconds: 300, resource: "asr", jti: "j"),
                signature: "sig", alg: "Ed25519"
            ),
            identity: VoiceConnectionIdentity(brokerUrl: "wss://b", resource: "asr", userID: "u", deviceID: "d")
        )
        store.save(lease)
        XCTAssertNotNil(DevSecretFileStore.read("voice-lease.json"))
        XCTAssertEqual(KeychainVoiceLeaseStore().load(), lease)

        // Nothing went to the keychain.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: KeychainVoiceLeaseStore.service,
            kSecAttrAccount as String: "current",
        ]
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, nil), errSecItemNotFound)

        store.clear()
        XCTAssertNil(DevSecretFileStore.read("voice-lease.json"))
    }

    // MARK: Built-in helper path

    func testHelperIsNamedKraki() {
        XCTAssertEqual(BuiltInTentacle.helperRelativePath, "Contents/Library/Helpers/Kraki.app")
        XCTAssertEqual(BuiltInTentacle.binaryRelativePath,
                       "Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki")
    }

    func testParsesTheProgramLaunchdRecorded() {
        let output = """
        gui/501/chat.kraki.mac.tentacle = {
        \tactive count = 1
        \tpath = (submitted by smd.583)
        \tstate = running
        \tprogram identifier = Contents/Library/Helpers/Kraki Tentacle.app/Contents/MacOS/kraki (mode: 2)
        \tparent bundle identifier = chat.kraki.mac
        }
        """
        XCTAssertEqual(TentacleCLIManager.programIdentifier(fromLaunchctlPrint: output),
                       "Contents/Library/Helpers/Kraki Tentacle.app/Contents/MacOS/kraki")
        XCTAssertNil(TentacleCLIManager.programIdentifier(fromLaunchctlPrint: "state = running"))
        XCTAssertTrue(TentacleCLIManager.isLegacyHelperProgram(
            "Contents/Library/Helpers/Kraki Tentacle.app/Contents/MacOS/kraki"))
        XCTAssertFalse(TentacleCLIManager.isLegacyHelperProgram(BuiltInTentacle.binaryRelativePath))
        XCTAssertFalse(TentacleCLIManager.isLegacyHelperProgram(
            "/Applications/Kraki.app/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki"))
    }
}
