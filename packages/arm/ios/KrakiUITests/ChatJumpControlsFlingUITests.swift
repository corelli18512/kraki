import XCTest

/// Real touch flings against the production chat list (offline visible-scroll
/// fixture, 240 messages). The ↑/↓ controls freeze while the list moves and
/// must be re-evaluated once a momentum fling settles (K-061 / ICH-294).
final class ChatJumpControlsFlingUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_IOS_VISIBLE_SCROLL_SCENARIO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["ios.visibleScrollScenario"].waitForExistence(timeout: 15))
    }

    func testJumpToLatestAppearsAfterAMomentumFlingSettles() {
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        settle(1.5)
        let jump = app.buttons["Jump to latest"]
        XCTAssertFalse(jump.exists && jump.isHittable, "entry rests on the newest tail")

        // Finger down the screen = toward older history, released with
        // momentum so the list decelerates (and pages older) on its own. The
        // last flings re-grab the list while it is still coasting.
        let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        for _ in 0..<4 {
            start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
        }
        settle(4)

        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "after-fling"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertTrue(jump.exists && jump.isHittable,
                      "away from the tail after the fling settles, Jump to latest must be offered without another touch")
    }

    private func settle(_ seconds: Double) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }
}
