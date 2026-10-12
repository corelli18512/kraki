import Foundation
import XCTest
@testable import Kraki_Dev

/// The App must link only after the Tentacle proved its key AND we proved ours.
/// Regression for the independent review's P1: a bare `ready` linked the App to
/// any process on the discovery port.
final class LocalLinkHandshakeTests: XCTestCase {
    private var signed: [String] = []

    private func machine(verifies: Bool = true, signs: Bool = true) -> LocalLinkHandshake {
        LocalLinkHandshake(
            appId: "app-1", tentacleId: "T1", appNonce: "N-app",
            verifyTentacle: { message, signature in
                verifies && signature == "sig-T" && message == LocalLinkClient.tentacleProof(appNonce: "N-app", appId: "app-1", tentacleId: "T1")
            },
            signApp: { [weak self] message in
                self?.signed.append(message)
                return signs ? "sig-A" : nil
            }
        )
    }

    private let challenge: [String: Any] = ["type": "challenge", "v": 1, "tentacleId": "T1", "nonce": "N-t", "signature": "sig-T"]
    private let ready: [String: Any] = ["type": "ready", "v": 1]

    func testHappyPath() {
        var m = machine()
        XCTAssertEqual(m.receive(challenge), .send(["type": "auth", "signature": "sig-A"]))
        XCTAssertEqual(signed, [LocalLinkClient.appProof(tentacleNonce: "N-t", tentacleId: "T1", appId: "app-1")])
        XCTAssertEqual(m.receive(ready), .linkUp)
        XCTAssertEqual(m.receive(["type": "pulse", "pulse": "AAAA"]), .deliverPulse("AAAA"))
    }

    func testBareReadyNeverLinks() {
        var m = machine()
        guard case .fail = m.receive(ready) else { return XCTFail("bare ready accepted") }
        XCTAssertNotEqual(m.phase, .ready)
        // Nothing after a failure revives it.
        XCTAssertEqual(m.receive(challenge), .ignore)
        XCTAssertEqual(m.receive(ready), .ignore)
    }

    func testPulseBeforeReadyFails() {
        var m = machine()
        guard case .fail = m.receive(["type": "pulse", "pulse": "AAAA"]) else { return XCTFail() }
        var m2 = machine()
        _ = m2.receive(challenge)
        guard case .fail = m2.receive(["type": "pulse", "pulse": "AAAA"]) else { return XCTFail() }
    }

    func testForgedOrWrongChallengeFailsAndSignsNothing() {
        for bad in [
            challenge.merging(["signature": "forged"]) { $1 },
            challenge.merging(["tentacleId": "T2"]) { $1 },
            challenge.merging(["v": 2]) { $1 },
            challenge.merging(["nonce": ""]) { $1 },
            challenge.merging(["nonce": String(repeating: "x", count: 257)]) { $1 },
            ["type": "challenge", "v": 1, "tentacleId": "T1", "nonce": "N-t"],
        ] {
            var m = machine()
            guard case .fail = m.receive(bad) else { return XCTFail("accepted \(bad)") }
        }
        var unverifiable = machine(verifies: false)
        guard case .fail = unverifiable.receive(challenge) else { return XCTFail() }
        XCTAssertTrue(signed.isEmpty, "never sign before the Tentacle proved itself")
    }

    func testSecondChallengeOrReadyWithWrongVersionFails() {
        var m = machine()
        _ = m.receive(challenge)
        guard case .fail = m.receive(challenge) else { return XCTFail("second challenge accepted") }
        var m2 = machine()
        _ = m2.receive(challenge)
        guard case .fail = m2.receive(["type": "ready", "v": 2]) else { return XCTFail() }
        var m3 = machine()
        _ = m3.receive(challenge)
        _ = m3.receive(ready)
        guard case .fail = m3.receive(ready) else { return XCTFail("duplicate ready accepted") }
    }

    func testSigningFailureAndServerErrorFail() {
        var m = machine(signs: false)
        guard case .fail = m.receive(challenge) else { return XCTFail() }
        var m2 = machine()
        guard case .fail = m2.receive(["type": "error", "code": "unknown_device"]) else { return XCTFail() }
    }
}
