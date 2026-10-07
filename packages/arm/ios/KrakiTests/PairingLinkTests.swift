import XCTest
@testable import Kraki

final class PairingLinkTests: XCTestCase {
    func testParsesTerminalQRLink() throws {
        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?relay=wss%3A%2F%2Fcn.relay.kraki.chat&token=pt_abc"))
        XCTAssertEqual(link.token, "pt_abc")
        XCTAssertEqual(link.relay, "wss://cn.relay.kraki.chat")
        XCTAssertFalse(link.needsRelayConfirmation)
    }

    func testIgnoresLinksWithoutToken() {
        XCTAssertNil(PairingLink(string: "https://app.kraki.chat/auth/callback?code=x&state=y"))
        XCTAssertNil(PairingLink(string: "https://app.kraki.chat/?token="))
    }

    func testUntrustedRelayNeedsConfirmation() throws {
        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?relay=wss://evil.example:4000&token=pt_1"))
        XCTAssertTrue(link.needsRelayConfirmation)
        XCTAssertEqual(link.relayHost, "evil.example:4000")
        XCTAssertFalse(PairingLink.isTrustedRelay("wss://kraki.chat.evil.example"))
        XCTAssertTrue(PairingLink.isTrustedRelay("ws://localhost:4000"))
        XCTAssertTrue(PairingLink.isTrustedRelay("wss://relay.kraki.chat"))
        XCTAssertFalse(PairingLink.isTrustedRelay("ws://relay.kraki.chat"), "Kraki relays only over TLS")
        XCTAssertTrue(AuthManager.isAllowedRegionRedirect("wss://cn.relay.kraki.chat"))
        XCTAssertFalse(AuthManager.isAllowedRegionRedirect("wss://evil.example"))
        XCTAssertFalse(AuthManager.isAllowedRegionRedirect("ws://cn.relay.kraki.chat"))
        XCTAssertFalse(AuthManager.isAllowedRegionRedirect("wss://kraki.chat.evil.example"))
    }

    func testFingerprintMatchesTentacle() {
        XCTAssertEqual(DeviceKeyPins.fingerprint("abc"), "ungWv48Bz-pBQUDeXa4iIw")
    }

    private func tentacle(_ id: String, key: String) -> DeviceSummary {
        DeviceSummary(id: id, name: id, role: .tentacle, kind: nil, publicKey: key, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
    }

    func testPinsOnFirstSightAndFailsClosedOnKeySwap() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "pins-\(UUID())"))
        let pins = DeviceKeyPins(defaults: defaults)
        XCTAssertEqual(pins.apply(tentacle("pc", key: "K1")).encryptionKey, nil)
        let swapped = pins.apply(tentacle("pc", key: "EVIL"))
        XCTAssertEqual(swapped.encryptionKey, "K1", "keeps encrypting to the trusted key")
        XCTAssertTrue(pins.mismatched.contains("pc"))
    }

    func testQRFingerprintPinsTheScannedComputer() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "pins-\(UUID())"))
        let pins = DeviceKeyPins(defaults: defaults)
        _ = pins.apply(tentacle("pc", key: "OLD"))
        pins.pendingQRFingerprint = DeviceKeyPins.fingerprint("NEW")
        XCTAssertTrue(pins.verifyPendingQR(against: [tentacle("pc", key: "NEW")]))
        XCTAssertNil(pins.apply(tentacle("pc", key: "NEW")).encryptionKey)
        XCTAssertFalse(pins.mismatched.contains("pc"))

        pins.pendingQRFingerprint = DeviceKeyPins.fingerprint("REAL")
        XCTAssertFalse(pins.verifyPendingQR(against: [tentacle("pc", key: "RELAY-KEY")]))
    }
}
