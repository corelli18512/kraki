import XCTest

/// Real touches on the production Session list while other Sessions get new
/// messages and move to the top (offline scenario, a `session_list` digest
/// every `KRAKI_SCENARIO_LIST_TICKER_MS`). Opens a row's swipe actions and
/// watches what happens to them across reorders. Record the simulator screen
/// alongside (`xcrun simctl io <udid> recordVideo`) to see the motion.
final class SessionListReorderUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_IOS_NEW_SESSION_SCENARIO"] = "1"
        app.launchEnvironment["KRAKI_SCENARIO_LIST_TICKER_MS"] = "2500"
        app.launch()
        XCTAssertTrue(app.tables["session-list-table"].waitForExistence(timeout: 10))
    }

    private var rows: XCUIElementQuery { app.tables["session-list-table"].cells }
    private func settle(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }

    private func log(_ line: String) {
        let stamped = String(format: "%.2f ", Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1000)) + line
        print("[reorder-ui] \(stamped)")
        if let path = ProcessInfo.processInfo.environment["KRAKI_REORDER_LOG"],
           let handle = FileHandle(forWritingAtPath: path) ?? {
               FileManager.default.createFile(atPath: path, contents: nil)
               return FileHandle(forWritingAtPath: path)
           }() {
            handle.seekToEndOfFile()
            handle.write(Data((stamped + "\n").utf8))
            try? handle.close()
        }
    }

    private func describeSwipe(_ label: String) {
        let pin = app.buttons["Pin"]
        let unread = app.buttons["Mark as Unread"]
        let pinFrame = pin.exists ? "\(pin.frame.integral)" : "gone"
        let unreadFrame = unread.exists ? "\(unread.frame.integral)" : "gone"
        let titles = (0..<min(rows.count, 6)).map { index -> String in
            let cell = rows.element(boundBy: index)
            return "\(Int(cell.frame.minY)):\(cell.staticTexts.firstMatch.label.prefix(18))"
        }
        log("\(label) pin=\(pinFrame) unread=\(unreadFrame) rows=\(titles)")
    }

    private func order() -> [String] {
        (0..<min(rows.count, 8)).map { rows.element(boundBy: $0).staticTexts.firstMatch.label }
    }

    /// Swipe a row open, then leave it alone while other Sessions get new
    /// messages: the list holds still (no row slides under the finger, the
    /// buttons never disappear), and catches up once the swipe closes.
    func testSwipeActionsSurviveReorder() {
        settle(5.5) // first tick arrives at ~6.5 s after launch
        let target = rows.element(boundBy: 3)
        let title = target.staticTexts.firstMatch.label
        log("swipe row 3 title=\(title)")
        target.swipeLeft()
        let pin = app.buttons["Pin"]
        XCTAssertTrue(pin.waitForExistence(timeout: 2))
        let pinFrame = pin.frame
        let frozen = order()
        describeSwipe("opened")
        for step in 1...6 { // ≥ 2 ticks while open
            settle(1.0)
            describeSwipe("t+\(step)s")
            XCTAssertTrue(pin.exists, "swipe actions stay open")
            XCTAssertEqual(pin.frame, pinFrame, "swipe actions stay put")
            XCTAssertEqual(order(), frozen, "rows don't move under an open swipe")
        }
        // Close the swipe; the deferred reorder lands.
        target.swipeRight()
        settle(1.2)
        describeSwipe("closed")
        XCTAssertFalse(app.buttons["Pin"].exists)
        XCTAssertNotEqual(order(), frozen, "deferred reorder applied after the swipe closed")
    }
}
