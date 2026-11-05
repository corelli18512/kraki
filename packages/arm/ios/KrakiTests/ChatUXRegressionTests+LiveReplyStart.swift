import XCTest
@testable import Kraki

#if os(iOS)
/// ↑ while a reply streams (K-174 / ICH-296): the reply being read is the
/// live one, so ↑ goes to its start once that start has scrolled away; while
/// its start is still on screen, ↑ goes to the previous reply (the confirmed
/// "step back through AI replies" rule).
extension ChatUXRegressionTests {
    func testUpDuringStreamingTargetsTheLiveReplyStartOnceItScrolledAway() throws {
        let fx = try makeFixture(total: 6)
        drain(800)
        let user = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": 7, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:01.000Z", "payload": ["content": "Write the essay"],
        ])
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageProvider?.ingestTailCandidate(sid, json: user)
        fx.vc.syncLiveUpdates()
        drain(200)

        // Short so far: its start is visible, ↑ steps back to the previous reply.
        fx.app.messageStore.applyCardMessage(sid, "The essay begins here.", reset: true)
        fx.vc.syncLiveUpdates()
        drain(300)
        let items = fx.vc.automationItemIDs
        let live = try XCTUnwrap(items.firstIndex(of: ChatPerfListVC.liveCardID))
        let shortTarget = try XCTUnwrap(fx.vc.automationUpTargetItem)
        XCTAssertLessThan(shortTarget, live, "start visible: the previous reply")

        // Taller than the screen while following the tail: the live start is gone.
        var text = ""
        while text.count < 6_000 { text += "\n\n" + Self.en + " " + Self.en }
        fx.app.messageStore.applyCardMessage(sid, text, reset: false)
        fx.vc.syncLiveUpdates()
        drain(600)
        XCTAssertEqual(fx.vc.automationUpTargetItem, fx.vc.automationItemIDs.firstIndex(of: ChatPerfListVC.liveCardID),
                       "↑ goes to the start of the reply being streamed")
    }
}
#endif
