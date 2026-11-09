import XCTest
@testable import Kraki

#if os(iOS)
extension ChatUXRegressionTests {
    private func boundsAnimations(_ cv: UICollectionView) -> [String] {
        (cv.layer.animationKeys() ?? []).filter { $0.hasPrefix("bounds") }
    }

    /// The "Compacting context…" row appears at once above the composer, so
    /// the list's extra clearance must apply in the same frame (animated, the
    /// newest reply was drawn under the row for a few frames, K-169). When the
    /// row goes away the tail still settles into the freed space.
    func testCompactionRowClearanceAppliesInTheSameFrame() throws {
        let fx = try makeFixture(total: 40, onScreen: true)
        drain(900)
        fx.cv.layoutIfNeeded()
        let resting = fx.cv.contentInset.bottom
        func distanceToBottom() -> CGFloat {
            fx.cv.contentSize.height + fx.cv.adjustedContentInset.bottom - fx.cv.bounds.height - fx.cv.contentOffset.y
        }
        XCTAssertLessThanOrEqual(abs(distanceToBottom()), 1, "starts at the newest edge")
        fx.cv.layer.removeAllAnimations()

        fx.vc.updateBottomContentInset(resting + 48)
        XCTAssertEqual(boundsAnimations(fx.cv), [], "the clearance for the new row must not animate in")
        XCTAssertLessThanOrEqual(abs(distanceToBottom()), 1, "the newest reply sits above the row at once")

        drain(600)
        fx.vc.updateBottomContentInset(resting)
        XCTAssertFalse(boundsAnimations(fx.cv).isEmpty, "the tail settles into the freed space")
        drain(600)
        XCTAssertLessThanOrEqual(abs(distanceToBottom()), 1)
    }
}
#endif
