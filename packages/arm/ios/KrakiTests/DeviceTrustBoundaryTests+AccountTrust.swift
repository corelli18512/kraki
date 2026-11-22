import CryptoKit
import Foundation
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Saved-connection recovery the user can follow (QA lane ios-account-trust).
extension DeviceTrustBoundaryTests {
    /// An unsigned inner message as the decrypt path hands it on when it is
    /// acceptable (not attributable to a pinned computer).
    func routeUnsigned(_ inner: [String: Any]) throws {
        var marked = inner
        marked[DeviceTrustInbound.unsignedKey] = true
        try XCTUnwrap(app.messageRouter).handleDataMessage(try json(marked))
    }

    /// K-026 / K-327: the banner names the real problem instead of advising
    /// to update Kraki on the computer.
    func testSavedConnectionNoticeNamesRevocationAndClockSkew() {
        XCTAssertEqual(AccountAccessNotice(state: .failed("revoked")), .pairingRevoked)
        XCTAssertEqual(AccountAccessNotice(state: .failed("stale")), .clockOff)
        XCTAssertEqual(AccountAccessNotice(state: .failed("from_future")), .clockOff)
        XCTAssertEqual(AccountAccessNotice(state: .failed("bad_proof")), .checkSavedConnection)
        let update = String(localized: "Update Kraki on this computer first.")
        for notice in [AccountAccessNotice.pairingRevoked, .clockOff] {
            XCTAssertFalse(notice.message(computer: "PC").contains("Update Kraki"), "\(notice)")
            XCTAssertFalse(notice.message(computer: "PC").contains(update), "\(notice)")
        }
        XCTAssertTrue(AccountAccessNotice.clockOff.message(computer: "PC").contains(String(localized: "This device's clock is off.")))
    }

    /// K-026: a computer that revoked this device (and now answers unsigned)
    /// shows the revocation notice with its recovery.
    func testRevocationShowsTheRevocationNotice() throws {
        pin()
        try seedSession()
        try route(signedEnvelope(message("trust_revoked", device: computer, payload: ["enforced": false]), key: signer))
        XCTAssertEqual(AccountAccessNotice(state: app.trustState(for: computer)), .pairingRevoked)
    }

    /// K-182 (and K-026's recovery): resetting the saved connection of a
    /// revoked computer resyncs at once instead of after a relaunch.
    func testResettingARevokedConnectionResyncsWithoutRelaunch() throws {
        pin()
        try seedSession()
        try route(signedEnvelope(message("trust_revoked", device: computer, payload: ["enforced": false]), key: signer))
        app.connectionStatus = .connected
        let before = app.deviceTrust.resyncRequestsForTesting
        app.forgetPairing(computer)
        XCTAssertEqual(app.deviceTrust.resyncRequestsForTesting, before + 1, "reconnects so the computer sends its sessions again")
        // Its unsigned messages are accepted again.
        try routeUnsigned(message("session_list", device: computer,
                                  payload: ["sessions": [["id": sid, "title": "after reset", "state": "idle"]]]))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.title, "after reset")
    }

    /// A computer that still trusts this device is told to revoke it and then
    /// sends a fresh session list itself: no reconnect needed.
    func testResettingAConnectionTheComputerStillTrustsDoesNotReconnect() throws {
        pin()
        app.connectionStatus = .connected
        let before = app.deviceTrust.resyncRequestsForTesting
        app.forgetPairing(computer)
        XCTAssertEqual(app.deviceTrust.resyncRequestsForTesting, before)
    }

    /// K-183: the "Update Kraki on …" hint goes once the computer serves this
    /// device its sessions (it stopped requiring pairing), not at relaunch.
    func testUpdateComputerHintClearsWhenTheComputerServesSessions() throws {
        app.handleTrustRequired(["deviceId": computer], signed: false)
        XCTAssertEqual(AccountAccessNotice(state: app.trustState(for: computer)), .updateComputer)
        try routeUnsigned(message("session_list", device: computer, payload: ["sessions": []]))
        XCTAssertFalse(app.deviceTrust.pairingRequired.contains(computer))
        XCTAssertNil(AccountAccessNotice(state: app.trustState(for: computer)))
    }
}
