import XCTest
import SwiftUI
@testable import Kraki

#if os(iOS)
/// Regressions from review group 2 (2026-10-13), on the `ChatUXRegressionTests`
/// fixture (kept in its own file: the main suite is at its SwiftLint size cap).
extension ChatUXRegressionTests {
    /// 2-02: an older page fetched while the reader was a screen or two up
    /// stays held after they return to the bottom. The agent's answer must
    /// still appear instead of waiting until the reader scrolls to the top.
    func testHeldOlderPageDoesNotBlockTheLiveAnswer() throws {
        let fx = try makeFixture(total: 120)
        drain(1_000)
        fx.vc.automationStageWarmBufferedOlderPage(pending: false)
        let cv = fx.cv
        let bottom = cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height
        cv.setContentOffset(CGPoint(x: 0, y: max(-cv.adjustedContentInset.top, bottom)), animated: false)
        drain(200)
        XCTAssertTrue(fx.vc.automationPaginationState.deferred, "the older page is held, not revealed")
        XCTAssertNotEqual(fx.vc.automationItemIDs, fx.vc.ids)

        let answer = try JSONSerialization.data(withJSONObject: [
            "type": "agent_message", "seq": 121, "sessionId": sid, "deviceId": "ux-gate-device",
            "timestamp": "2026-09-01T00:00:02.000Z", "payload": ["content": "The answer landed."],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: answer)
        fx.vc.syncLiveUpdates()
        drain(600)

        XCTAssertEqual(fx.vc.automationItemIDs, fx.vc.ids, "the answer (and the held page) are shown")
        XCTAssertEqual(cv.numberOfItems(inSection: 0), fx.vc.automationItemIDs.count,
                       "collection view and data source agree")
        XCTAssertFalse(fx.vc.automationPaginationState.deferred)
    }
}
#endif
