import XCTest
import UIKit
@testable import Kraki

#if os(iOS)
extension ChatUXRegressionTests {
    /// K-058: returning to the app (from a link opened in Safari) re-arms the
    /// visible bubbles' interaction without needing a scroll.
    func testReturningToTheAppReArmsVisibleBubbleInteraction() throws {
        let fx = try makeFixture(total: 40)
        drain(300)
        func tables() -> [TKTableScrollView] {
            fx.cv.visibleCells.flatMap { cell in
                var found: [TKTableScrollView] = []
                func walk(_ v: UIView) { if let t = v as? TKTableScrollView { found.append(t) }; v.subviews.forEach(walk) }
                walk(cell)
                return found
            }
        }
        // Find a table among the rows and bring it on screen.
        if tables().isEmpty {
            let rows = fx.cv.numberOfItems(inSection: 0)
            for item in stride(from: rows - 1, through: 0, by: -1) {
                fx.cv.scrollToItem(at: IndexPath(item: item, section: 0), at: .centeredVertically, animated: false)
                fx.cv.layoutIfNeeded()
                if !tables().isEmpty { break }
            }
            fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
            drain(200)
        }
        XCTAssertFalse(tables().isEmpty, "fixture shows a table")
        XCTAssertTrue(tables().allSatisfy(\.isUserInteractionEnabled), "tables are live at rest")
        // Interaction left switched off (as by a gesture cut short when the
        // app went to the background).
        for cell in fx.cv.visibleCells { (cell as? TKBubbleCell)?.setBodyInteractive(false) }
        XCTAssertFalse(tables().contains(where: \.isUserInteractionEnabled))
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        drain(50)
        XCTAssertTrue(tables().allSatisfy(\.isUserInteractionEnabled), "re-armed on return, without a scroll")
    }
}
#endif
