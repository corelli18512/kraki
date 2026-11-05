import XCTest
@testable import Kraki

#if os(iOS)
/// K-062: a catch-up after an outage lands as several applies a few ms apart
/// (one or two rows each). Together they are one burst, not conversation
/// beats: none of its rows slides in.
extension ChatUXRegressionTests {
    private func arrive(_ fx: Fx, seq: Int) throws {
        let type = seq % 2 == 1 ? "user_message" : "agent_message"
        fx.app.messageProvider?.ingestTailCandidate(sid, json: try JSONSerialization.data(withJSONObject: [
            "type": type, "seq": seq, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:05.000Z", "payload": ["content": "catch-up \(seq)"],
        ]))
        fx.vc.syncLiveUpdates()
    }

    private func animatingEntrances(_ fx: Fx) -> [String] {
        fx.cv.indexPathsForVisibleItems.compactMap { ip in
            guard fx.cv.cellForItem(at: ip)?.layer.animation(forKey: "kraki.entrance") != nil else { return nil }
            return fx.vc.automationItemIDs[ip.item]
        }
    }

    func testCatchUpLandingOneRowPerApplyDoesNotCascadeIn() throws {
        let fx = try makeFixture(total: 60)
        drain(1_000)
        for seq in 61...66 { try arrive(fx, seq: seq) }
        XCTAssertEqual(fx.vc.automationItemIDs.suffix(6), (61...66).map { "\(sid):\($0)" })
        XCTAssertTrue(animatingEntrances(fx).isEmpty, "a catch-up burst lands in place: \(animatingEntrances(fx))")
        XCTAssertTrue(fx.vc.pendingEntrances.isEmpty)
        XCTAssertNil(fx.cv.layer.animation(forKey: "kraki.arrivalGlide"))
    }

    func testSeparateBeatsStillEnter() throws {
        let fx = try makeFixture(total: 60)
        drain(1_000)
        try arrive(fx, seq: 61)
        drain(600)
        try arrive(fx, seq: 62)
        drain(600)
        try arrive(fx, seq: 63)
        XCTAssertEqual(fx.vc.entranceLog.map(\.id), (61...63).map { "\(sid):\($0)" })
    }
}
#endif
