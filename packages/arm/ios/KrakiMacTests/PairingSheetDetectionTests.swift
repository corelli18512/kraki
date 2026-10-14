import XCTest
@testable import Kraki_Dev

/// QR is an optional account sign-in shortcut, not a device access gate.
@MainActor
final class PairingSheetDetectionTests: XCTestCase {
    private func entry(_ id: String, _ pairedAt: String = "2026-10-14T10:00:00.000Z") -> TrustedDeviceEntry {
        TrustedDeviceEntry(id: id, name: id, via: "qr", pairedAt: pairedAt)
    }

    func testNewAccountDeviceCountsWithoutAnyTrustedDevicesList() {
        XCTAssertEqual(PairingSheet.newlyConnected(["old-phone", "web"], baseline: ["old-phone"]), "web")
        XCTAssertEqual(PairingSheet.newlyConnected(["phone"], baseline: []), "phone")
    }

    func testAlreadyOnlineDevicesDoNotCompleteTheSignInSheet() {
        XCTAssertNil(PairingSheet.newlyConnected(["old-phone"], baseline: ["old-phone"]))
        XCTAssertNil(PairingSheet.newlyConnected([], baseline: ["old-phone"]))
    }

    func testOptionalEncryptionHandshakeStillDetectsAnExistingPhone() {
        let phone = entry("phone")
        let repaired = entry("phone", "2026-10-14T11:00:00.000Z")
        XCTAssertNil(PairingSheet.newlyPaired([phone], baseline: [phone]))
        XCTAssertEqual(PairingSheet.newlyPaired([repaired], baseline: [phone]), "phone")
    }
}
