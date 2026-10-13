import CoinfraCrypto
import CryptoKit
import Foundation
import UserNotifications
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Round-2 security review regressions (docs/e2e-trust.md).
extension DeviceTrustBoundaryTests {
    /// APPS-01: a cold launch (stored credentials, not yet connected) asks too.
    func testColdLaunchLinkCannotReplacePinWithoutConfirmation() throws {
        pin()
        app.hasStoredCredentials = true
        app.hasCompletedInitialConnect = false
        let before = TentacleTrustStore.shared.pin(computer)
        app.openPairingLink(try link(identity: Curve25519.Signing.PrivateKey(), encryption: Curve25519.KeyAgreement.PrivateKey()))
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before)
        guard case .replaceComputerKey? = app.pendingPairingPrompt else { return XCTFail("Missing key-change prompt") }
    }

    /// APPS-07: a code for another account's computer offers the account switch.
    func testOtherAccountsCodeOffersAccountSwitchInsteadOfPinning() throws {
        app.hasStoredCredentials = true
        app.hasCompletedInitialConnect = true
        app.openPairingLink(try link(identity: Curve25519.Signing.PrivateKey(), encryption: Curve25519.KeyAgreement.PrivateKey()))
        XCTAssertNil(TentacleTrustStore.shared.pin(computer))
        guard case .alreadyConnected? = app.pendingPairingPrompt else { return XCTFail("Expected account-switch prompt") }
    }

    /// R2-D01: a pinned computer's signed list takes a session back from an
    /// unpinned (relay-made) device that claimed it first.
    func testSignedOwnerTakesSessionBackFromUnpinnedClaimant() throws {
        pin()
        let relayKey = try CryptoManager().generateKeyPair()
        let relayPublic = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        app.deviceStore.setDevices([
            DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: relayPublic, online: true),
            DeviceSummary(id: other, name: "Relay made", role: .tentacle, kind: .desktop, encryptionKey: relayPublic, online: true),
        ])
        try route(legacyEnvelope(message("session_list", device: other, payload: ["sessions": [["id": sid, "title": "forged", "state": "idle"]]]), src: other))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.deviceId, other)
        try route(signedEnvelope(message("session_list", device: computer, payload: ["sessions": [["id": sid, "title": "authentic", "state": "idle"]]]), key: signer))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.deviceId, computer)
        XCTAssertTrue(app.sendEncryptedMessage(message("send_input", session: sid, payload: ["text": "secret"])))
        let payload = try XCTUnwrap(outbound().last)
        XCTAssertEqual(payload["v"] as? Int, 2, "input goes signed to the pinned key")
    }

    /// APPS-05: if sealing to pinned computers fails, they get nothing — not the legacy payload.
    func testBroadcastSealingFailureNeverFallsBackToRelayKeys() throws {
        let identity = DeviceTrustWire.b64url(signer.publicKey.rawRepresentation)
        // A low-order (all-zero) X25519 key makes sealing fail.
        TentacleTrustStore.shared.update(computer) {
            $0 = TentaclePin(identityKey: identity, encryptionKey: DeviceTrustWire.b64url(Data(count: 32)),
                             paired: true, secret: nil, via: "qr", pinnedAt: Date())
        }
        let relayKey = try CryptoManager().generateKeyPair()
        let reported = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        app.deviceStore.setDevices([
            DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: reported, online: false),
            DeviceSummary(id: other, name: "Legacy", role: .tentacle, kind: .desktop, encryptionKey: reported, online: false),
        ])
        _ = app.sendEncryptedMessage(message("request_sessions"))
        for payload in try outbound() {
            XCTAssertFalse((payload["keys"] as? [String: String] ?? [:]).keys.contains(computer))
        }
    }

    /// R2-D04: turning on "Only paired devices" is pending until the computer confirms.
    func testPolicyChangeIsPendingUntilConfirmed() throws {
        pin()
        app.deviceTrust.info[computer] = ComputerTrustInfo(enforced: false, policyLocked: false, devices: [], policyRevision: 3)
        app.setOnlyPairedDevices(true, on: computer)
        XCTAssertEqual(app.deviceTrust.info[computer]?.enforced, false)
        XCTAssertEqual(app.deviceTrust.info[computer]?.pendingEnforce, true)
        try route(signedEnvelope(message("trusted_devices", device: computer, payload: ["enforced": true, "policyRevision": 4, "devices": []]), key: signer))
        XCTAssertEqual(app.deviceTrust.info[computer]?.enforced, true)
        XCTAssertNil(app.deviceTrust.info[computer]?.pendingEnforce)
    }

    /// PROT2-05 (Swift side): delimiter-bearing ids and odd nonces are not signed messages.
    func testSignedParsingRejectsAmbiguousFields() throws {
        var object = try DeviceTrustWire.sign(body: "{}", from: computer, to: selfId, key: signer)
        XCTAssertNotNil(DeviceTrustWire.parseSigned(object))
        object["from"] = "a\nb"
        XCTAssertNil(DeviceTrustWire.parseSigned(object))
        var odd = try DeviceTrustWire.sign(body: "{}", from: computer, to: selfId, key: signer)
        odd["nonce"] = "short"
        XCTAssertNil(DeviceTrustWire.parseSigned(odd))
    }

    /// Transition: a paired computer that starts sending unsigned messages
    /// (Kraki downgraded there) is flagged; a signed message clears it; the
    /// user can forget the pairing and fall back to the unpaired connection.
    func testDowngradedComputerIsFlaggedAndCanBeForgotten() throws {
        pin()
        let relayKey = try CryptoManager().generateKeyPair()
        let reported = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        app.deviceStore.setDevices([DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: reported, online: true)])
        try seedSession()
        try route(legacyEnvelope(message("agent_message", device: computer, session: sid, payload: ["content": "unsigned"]), src: computer))
        let flagged = expectation(description: "flagged")
        DispatchQueue.main.async { flagged.fulfill() }
        wait(for: [flagged], timeout: 2)
        XCTAssertEqual(app.trustState(for: computer), .stoppedSigning)
        XCTAssertFalse(app.computersNeedingPairing.isEmpty, "the banner offers to forget the pairing")
        // The real computer still signing clears it.
        try route(signedEnvelope(message("session_list", device: computer, payload: ["sessions": [["id": sid, "title": "t", "state": "idle"]]]), key: signer))
        XCTAssertEqual(app.trustState(for: computer), .paired)
        // Forgetting goes back to the legacy (unpaired) path.
        app.forgetPairing(computer)
        XCTAssertNil(TentacleTrustStore.shared.pin(computer))
        XCTAssertEqual(app.trustState(for: computer), .notPaired)
        XCTAssertTrue(app.sendEncryptedMessage(message("send_input", session: sid, payload: ["text": "after forget"])))
        let payload = try XCTUnwrap(outbound().last)
        XCTAssertNotNil(payload["keys"], "unpaired again: legacy RSA envelope")
    }

    /// trust_revoked never removes a pin: the computer is marked revoked
    /// (pair again or Forget Pairing). Unsigned notices change nothing, and a
    /// replayed old one is undone by the next signed message (DT503-06).
    func testRevocationKeepsThePinAndAReplayedOneIsUndone() throws {
        pin()
        try seedSession()
        try route(legacyEnvelope(message("trust_revoked", device: computer, payload: ["enforced": false]), src: computer))
        XCTAssertEqual(app.trustState(for: computer), .paired, "unsigned notice ignored")
        try route(signedEnvelope(message("trust_revoked", device: computer, payload: ["enforced": false]), key: signer))
        XCTAssertNotNil(TentacleTrustStore.shared.pin(computer), "keys stay pinned")
        XCTAssertEqual(app.trustState(for: computer), .failed("revoked"))
        // Still encrypting to the pinned key, never to a relay-reported one.
        XCTAssertTrue(app.sendEncryptedMessage(message("send_input", session: sid, payload: ["text": "after revoke"])))
        XCTAssertEqual(try XCTUnwrap(outbound().last)["v"] as? Int, 2)
        // The computer's next ordinary signed message: the notice was stale.
        try route(signedEnvelope(message("session_list", device: computer, payload: ["sessions": [["id": sid, "title": "t", "state": "idle"]]]), key: signer))
        XCTAssertEqual(app.trustState(for: computer), .paired)
    }

    /// PR review: a relay-assigned app id never becomes a path outside local-enroll.
    func testFileSafeIds() {
        XCTAssertTrue(DeviceTrustWire.isFileSafeId("dev_c0e1672f-92d"))
        for bad in ["../../config", "a/b", "", ".", "x.json", String(repeating: "a", count: 129)] {
            XCTAssertFalse(DeviceTrustWire.isFileSafeId(bad), bad)
        }
    }

    /// DT503-02: when a pinned computer takes a session back, what the
    /// unpinned claimant supplied (history, preview) is dropped.
    func testTakeoverDropsUnauthenticatedHistory() throws {
        pin()
        let relayKey = try CryptoManager().generateKeyPair()
        let relayPublic = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        app.deviceStore.setDevices([
            DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: relayPublic, online: true),
            DeviceSummary(id: other, name: "Relay made", role: .tentacle, kind: .desktop, encryptionKey: relayPublic, online: true),
        ])
        try route(legacyEnvelope(message("session_list", device: other, payload: ["sessions": [["id": sid, "title": "forged", "state": "idle", "lastSeq": 1]]]), src: other))
        // What the unpinned claimant supplied: cached history and a preview.
        try app.messageDatabase.insert(sid, [ChatMessage(type: "agent_message", seq: 1, sessionId: sid, deviceId: other, timestamp: nil, payload: ["content": AnyCodable("FORGED")])])
        app.sessionStore.sessionPreviews[sid] = SessionPreview(text: "FORGED", type: "message", timestamp: "2099-01-01T00:00:00Z")
        try route(signedEnvelope(message("session_list", device: computer, payload: ["sessions": [["id": sid, "title": "authentic", "state": "idle", "lastSeq": 1]]]), key: signer))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.deviceId, computer)
        XCTAssertFalse(app.messageDatabase.messagesAfter(sid, afterSeq: 0, limit: 100).contains { $0.content == "FORGED" })
        XCTAssertNotEqual(app.sessionStore.sessionPreviews[sid]?.text, "FORGED")
    }

    /// DT503-02: messages buffered in the provider (a seq gap) are dropped
    /// with the takeover, not re-drained into the authenticated session.
    func testTakeoverDropsBufferedUnauthenticatedMessages() throws {
        pin()
        let relayKey = try CryptoManager().generateKeyPair()
        let relayPublic = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        app.deviceStore.setDevices([
            DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: relayPublic, online: true),
            DeviceSummary(id: other, name: "Relay made", role: .tentacle, kind: .desktop, encryptionKey: relayPublic, online: true),
        ])
        try route(legacyEnvelope(message("session_list", device: other, payload: ["sessions": [["id": sid, "title": "forged", "state": "idle", "lastSeq": 0]]]), src: other))
        // Forged seq 2 with nothing before it: held in the provider's buffer.
        try route(legacyEnvelope(message("agent_message", device: other, session: sid, payload: ["content": "BUFFERED_FORGERY"]).merging(["seq": 2]) { $1 }, src: other))
        try route(signedEnvelope(message("session_list", device: computer, payload: ["sessions": [["id": sid, "title": "authentic", "state": "idle", "lastSeq": 1]]]), key: signer))
        // The computer's genuine seq 1.
        try route(signedEnvelope(message("agent_message", device: computer, session: sid, payload: ["content": "AUTHENTIC"]).merging(["seq": 1]) { $1 }, key: signer))
        let contents = app.messageDatabase.messagesAfter(sid, afterSeq: 0, limit: 100).compactMap(\.content)
        XCTAssertFalse(contents.contains("BUFFERED_FORGERY"), "\(contents)")
    }

    #if os(iOS)
    /// APPS-02: a push without a usable envelope shows generic text, not the relay's.
    func testNotificationServiceIgnoresRelayTextWithoutEnvelope() throws {
        pin()
        for info in [[String: Any](), ["kraki": ["blob": "x"]], ["sessionId": sid]] {
            let content = UNMutableNotificationContent()
            content.title = "Forged title"
            content.body = "Forged body"
            content.userInfo = info
            var output: UNNotificationContent?
            NotificationService().didReceive(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { output = $0 }
            XCTAssertEqual(output?.title, "Kraki")
            XCTAssertEqual(output?.body, "Open Kraki to view the update.")
            XCTAssertEqual(output?.threadIdentifier ?? "", "", "no grouping by a relay-chosen session")
            XCTAssertNil(output?.userInfo["sessionId"], "no tap target from the relay (DT503-04)")
        }
    }
    #endif
}
