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

    /// K-007: a link that cold-launches a signed-in app (before the first
    /// connection) asks before switching accounts, like a warm one does.
    @MainActor
    func testColdLaunchLinkWhileSignedInAsksBeforeSwitchingAccounts() throws {
        let app = AppState.makeUnitTestHost()
        app.hasStoredCredentials = true
        app.hasCompletedInitialConnect = false
        app.user = UserInfo(id: "u1", login: "octo", provider: "github")
        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?relay=wss%3A%2F%2Frelay.kraki.chat&token=pt_other"))
        app.openPairingLink(link)
        XCTAssertEqual(app.pendingPairingPrompt, .alreadyConnected(link, login: "octo"))
        XCTAssertNotEqual(app.connectionStatus, .authenticating, "no pairing on top of the stored identity")
    }

    @MainActor
    func testLinkWhileSignedOutPairsWithoutPrompt() throws {
        let app = AppState.makeUnitTestHost()
        app.hasStoredCredentials = false
        app.hasCompletedInitialConnect = false
        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?token=pt_new"))
        app.openPairingLink(link)
        XCTAssertNil(app.pendingPairingPrompt)
        XCTAssertEqual(app.connectionStatus, .authenticating)
    }

    /// K-303: only the relay reports the new key, so messages may still reach
    /// the computer; the warning must not say they won't.
    @MainActor
    func testKeyChangeWarningDoesNotClaimMessagesFail() throws {
        let app = AppState.makeUnitTestHost()
        app.deviceStore.setDevices([tentacle("pc", key: "K1")])
        app.deviceStore.keyMismatchDeviceIds = ["pc"]
        let message = try XCTUnwrap(app.keyWarning?.message)
        XCTAssertFalse(message.contains("won't go through"), message)
        XCTAssertTrue(message.contains("Kraki keeps encrypting to the key it trusted."), message)
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
