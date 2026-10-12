import XCTest
@testable import Kraki_Dev

/// The Mac sidebar "working" dots must keep animating after their row is
/// scrolled away (and its animation dropped) and scrolled back — the bug
/// fixed in 211b495b. Runs the same scenario the automation driver exposes.
@MainActor final class MacSidebarActivityDotsScrollTests: XCTestCase {
    func testActivityDotsResumeAfterScrollingAwayAndBack() async throws {
        try requireForegroundUITests()
        let result: [String: Any] = await withCheckedContinuation { done in
            MacSessionActivityDotsRegression.run { done.resume(returning: $0) }
        }
        XCTAssertEqual(result["passed"] as? Bool, true, "\(result)")
        XCTAssertEqual(result["restoredAnimations"] as? Bool, true)
        XCTAssertEqual(result["returnedMoving"] as? Bool, true)
    }
}
