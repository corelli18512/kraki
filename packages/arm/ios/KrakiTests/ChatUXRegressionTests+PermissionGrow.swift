import XCTest
@testable import Kraki

#if os(iOS)
/// K-070: when a permission card arrives on a streaming bubble, the bubble
/// grows; its rounded bottom must never be cut off flat while it does.
extension ChatUXRegressionTests {
    func testPermissionCardArrivalGrowsTheBubbleWithoutClippingItsBottom() throws {
        let fx = try makeFixture(total: 20, onScreen: true)
        drain(800)
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageStore.applyCardMessage(sid, "I need to update the config before running the tests.", reset: true)
        fx.vc.syncLiveUpdates()
        drain(600)
        let permission = ChatMessage(type: "permission", seq: 0, sessionId: nil, deviceId: nil, timestamp: nil, payload: [
            "id": AnyCodable("perm-1"), "toolName": AnyCodable("shell"),
            "description": AnyCodable("Run: rm -rf build && pnpm build"),
            "args": AnyCodable(["command": "rm -rf build && pnpm build"]),
        ])
        fx.app.messageStore.applyCardAction(sid, permission)
        fx.vc.syncLiveUpdates()
        var worst: CGFloat = 0
        var heights: [CGFloat] = []
        for _ in 0..<40 {
            drain(16)
            guard let index = fx.vc.automationItemIDs.firstIndex(of: "__live_card__"),
                  let cell = fx.cv.cellForItem(at: IndexPath(item: index, section: 0)) as? TKBubbleCell else { continue }
            worst = max(worst, cell.bubbleClippedDepthForRegression)
            heights.append(cell.layer.presentation()?.bounds.height ?? cell.bounds.height)
        }
        XCTAssertLessThanOrEqual(worst, 1, "bubble bottom cut off by \(worst) pt; cell heights \(heights)")
    }
}
#endif
