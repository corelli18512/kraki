import XCTest

/// Real touch-driven navigation gestures (edge swipe, cancelled swipe, taps
/// during transitions) against the production MainTabView with the offline
/// new-Session scenario fixture. Checks that the tab bar is visible exactly on
/// root pages and hidden inside Session / Device detail pages.
final class TabBarNavigationUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_IOS_NEW_SESSION_SCENARIO"] = "1"
        app.launch()
        XCTAssertTrue(row(0).waitForExistence(timeout: 10))
    }

    // MARK: Helpers

    private func row(_ index: Int) -> XCUIElement {
        // Fixture rows 4 and 5 carry long titles (header truncation checks).
        let titles = [3: "重构 iOS 聊天列表的滚动锚点、流式增量渲染和发送状态机（第二轮验收）",
                      4: "Refactor the iOS chat list scroll anchoring and streaming renderer"]
        return app.staticTexts[titles[index] ?? "Existing session \(index + 1)"].firstMatch
    }

    private var tabBarVisible: Bool {
        let button = app.buttons["Sessions"].firstMatch
        guard button.exists else { return false }
        let frame = button.frame
        return button.isHittable && frame.maxY <= app.frame.maxY && frame.height > 0
    }

    private var inChat: Bool {
        app.textViews.firstMatch.exists || app.textFields.firstMatch.exists
    }

    private func settle(_ seconds: Double = 0.9) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    /// Edge swipe from the left. `to` is the release point (fraction of width).
    private func edgeSwipe(to fraction: CGFloat, hold: TimeInterval = 0, fast: Bool = false) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: fraction, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end,
                    withVelocity: fast ? .fast : XCUIGestureVelocity(220),
                    thenHoldForDuration: hold)
    }

    private func expect(_ visible: Bool, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let ok = tabBarVisible == visible
        if !ok {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = label
            shot.lifetime = .keepAlways
            add(shot)
        }
        XCTAssertEqual(tabBarVisible, visible, "\(label): tab bar should be \(visible ? "visible" : "hidden")",
                       file: file, line: line)
    }

    /// The invariant, whatever page a racy gesture actually landed on: the
    /// tab bar is visible on the root list and hidden on a detail page.
    private func expectConsistent(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let onList = row(5).exists && row(5).isHittable
        expect(onList, "\(label) (onList=\(onList))", file: file, line: line)
    }

    private func backToList() {
        for _ in 0..<3 where !(row(5).exists && row(5).isHittable) {
            edgeSwipe(to: 0.9); settle()
        }
    }

    private func backButton() -> XCUIElement {
        app.buttons["Back"].firstMatch
    }

    // MARK: Cases

    func testOpenAndSwipeBack() {
        expect(true, "list")
        row(0).tap(); settle()
        expect(false, "chat")
        edgeSwipe(to: 0.9); settle()
        expect(true, "after full swipe back")
    }

    func testCancelledSwipesKeepChatAndTabBarState() {
        row(0).tap(); settle()
        for attempt in 1...4 {
            // Slow partial drag released with no velocity: UIKit cancels.
            edgeSwipe(to: 0.3, hold: 0.3); settle()
            XCTAssertFalse(row(5).isHittable, "cancelled swipe #\(attempt) must stay in chat")
            expect(false, "chat after cancelled swipe #\(attempt)")
        }
        edgeSwipe(to: 0.9); settle()
        expect(true, "list after cancelled swipes then full swipe")
        row(1).tap(); settle()
        expect(false, "second chat")
        edgeSwipe(to: 0.9); settle()
        expect(true, "list after second chat")
    }

    func testTapDuringPopAndPushTransitions() {
        for round in 1...3 {
            row(0).tap(); settle()
            backButton().tap()
            // Tap another row while the pop is still animating.
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
            if row(round).isHittable { row(round).tap() }
            settle(1.2)
            if tabBarVisible && !app.buttons["Back"].exists {
                expect(true, "list round \(round)")
            } else {
                expect(false, "chat round \(round)")
                edgeSwipe(to: 0.9); settle()
                expect(true, "list after round \(round)")
            }
        }
    }

    func testSwipeImmediatelyAfterPush() {
        for round in 1...3 {
            row(round % 3).tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
            edgeSwipe(to: 0.9, fast: true); settle(1.2)
            expect(true, "list after quick push+swipe \(round)")
        }
    }

    func testPartialThenFullAndBackButton() {
        row(2).tap(); settle()
        edgeSwipe(to: 0.45, hold: 0.4); settle(0.5)
        edgeSwipe(to: 0.9); settle()
        expect(true, "list after partial then full")
        row(2).tap(); settle()
        backButton().tap(); settle()
        expect(true, "list after back button")
        row(3).tap(); settle()
        expect(false, "chat again")
    }

    func testDeviceDetailToSessionAndBack() {
        app.buttons["Devices"].firstMatch.tap(); settle()
        expect(true, "devices list")
        app.staticTexts["Scenario Mac"].firstMatch.tap(); settle()
        expect(false, "device detail")
        let session = app.staticTexts["Existing session 1"].firstMatch
        if session.waitForExistence(timeout: 3) {
            session.tap(); settle()
            expect(false, "session from device")
            edgeSwipe(to: 0.3, hold: 0.3); settle()
            expect(false, "session from device after cancelled swipe")
            edgeSwipe(to: 0.9); settle()
            expect(false, "back on device detail")
        }
        edgeSwipe(to: 0.9); settle()
        expect(true, "devices list again")
        app.buttons["Sessions"].firstMatch.tap(); settle()
        expect(true, "sessions list")
    }

    /// Hold the edge swipe mid-way for a while (tab bar partially moved), then
    /// cancel; repeat quickly with a completed swipe.
    func testLongHeldSwipesAndRapidRepeats() {
        row(0).tap(); settle()
        // Released exactly at half width: UIKit may either complete or cancel.
        // Whatever it decided, the tab bar must match the page it settled on.
        edgeSwipe(to: 0.5, hold: 1.5); settle()
        expectConsistent("after long held half-way release")
        if row(5).isHittable { row(0).tap(); settle() }
        edgeSwipe(to: 0.3, hold: 1.5); settle()
        expect(false, "chat after long held cancel")
        edgeSwipe(to: 0.25, hold: 0.0, fast: false); settle(0.3)
        edgeSwipe(to: 0.9, fast: true); settle()
        expectConsistent("after rapid swipes")
        backToList()
        expect(true, "list after rapid swipes")
        for index in 0..<4 {
            if row(index).isHittable { row(index).tap() }
            settle(0.45)
            edgeSwipe(to: 0.9, fast: true); settle(0.45)
            expectConsistent("rapid open/close #\(index)")
        }
        settle()
        backToList()
        expect(true, "list after rapid open/close")
    }

    /// Slow, visible gestures for frame-by-frame review of the tab bar during
    /// swipe-back: a held swipe that is cancelled, then a slow completed one.
    func testSwipeBackTimingForRecording() {
        row(0).tap(); settle(1.5)
        edgeSwipe(to: 0.35, hold: 1.2); settle(1.2)
        XCTAssertFalse(row(5).isHittable, "short held swipe must cancel")
        expect(false, "chat after held cancel")
        edgeSwipe(to: 0.95, hold: 0.8); settle(1.5)
        expect(true, "list after slow completed swipe")
    }

    /// Header mode control: expand, pick a mode, auto-collapse to it.
    func testHeaderModePicker() {
        row(0).tap(); settle()
        let collapsed = app.buttons["chat.mode.collapsed"]
        XCTAssertTrue(collapsed.waitForExistence(timeout: 3))
        XCTAssertTrue(collapsed.label.contains("Discuss"))
        collapsed.tap(); settle(0.5)
        let execute = app.buttons["chat.mode.execute"]
        XCTAssertTrue(execute.waitForExistence(timeout: 2), "expanded picker shows all modes")
        XCTAssertTrue(app.buttons["chat.mode.safe"].exists && app.buttons["chat.mode.delegate"].exists)
        execute.tap(); settle(1.2)
        XCTAssertTrue(collapsed.waitForExistence(timeout: 2), "picker collapses after choosing")
        XCTAssertTrue(collapsed.label.contains("Execute"), "collapsed capsule shows the new mode")
        expect(false, "chat with mode picker")
        collapsed.tap(); settle(4.0)
        XCTAssertTrue(collapsed.exists, "idle expansion collapses by itself")
    }
}
