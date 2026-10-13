import XCTest
import SwiftUI
@testable import Kraki

#if os(iOS)
/// Regressions from review group 1 (2026-10-13), on the `ChatUXRegressionTests`
/// fixture (kept in its own file: the main suite is at its SwiftLint size cap).
extension ChatUXRegressionTests {
    func testClosedChatControllerIsReleased() throws {
        weak var weakVC: ChatPerfListVC?
        try autoreleasepool {
            let fx = try makeFixture(total: 40)
            weakVC = fx.vc
            let window = windows.removeLast()
            fx.vc.viewWillDisappear(false)
            fx.vc.viewDidDisappear(false)
            window.rootViewController = nil
            window.isHidden = true
        }
        drain(300)
        XCTAssertNil(weakVC, "the frame monitor (or something else) still retains the chat controller")
    }

    /// 1-03 (2026-10-13 review): ↑ through a long conversation while the live
    /// card is showing pages older history in via `nav-older`; the window then
    /// trims rows BEFORE the live card (a middle deletion). Edge-only batch
    /// updates raised UIKit's "invalid number of items" exception.
    func testUpThroughLongHistoryWithLiveCardKeepsTheListConsistent() throws {
        let fx = try makeFixture(total: 600)
        drain(1_500)
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageStore.applyCardMessage(sid, "Working on it\u{2026}", reset: true)
        fx.vc.syncLiveUpdates()
        drain(500)
        XCTAssertEqual(fx.vc.automationItemIDs.last, ChatPerfListVC.liveCardID, "live card at the tail")
        for _ in 0..<40 {
            fx.vc.automationTapUp()
            drain(700)
            XCTAssertEqual(fx.cv.numberOfItems(inSection: 0), fx.vc.automationItemIDs.count,
                           "collection view and data source agree")
        }
        XCTAssertEqual(fx.vc.automationItemIDs.last, ChatPerfListVC.liveCardID)
    }
}
#endif
