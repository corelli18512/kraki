import XCTest

/// Creating a Session the way a user does: the tab bar "+", the New Session
/// sheet, Create. Regression: selecting the search-role "+" tab re-hosted the
/// Sessions stack, so every page pushed afterwards lost its safe-area insets
/// (header under the status bar, Back untappable) and the tab bar stayed
/// hidden after returning to the list.
final class NewSessionJourneyUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_IOS_NEW_SESSION_SCENARIO"] = "1"
    }

    private func launch(createDelayMs: Int? = nil) {
        if let createDelayMs { app.launchEnvironment["KRAKI_SCENARIO_CREATE_DELAY_MS"] = String(createDelayMs) }
        app.launch()
        XCTAssertTrue(app.staticTexts["Existing session 1"].firstMatch.waitForExistence(timeout: 10))
    }
    private func settle(_ s: Double = 1.2) { RunLoop.current.run(until: Date().addingTimeInterval(s)) }
    private var tabBarVisible: Bool {
        let b = app.buttons["Sessions"].firstMatch
        return b.exists && b.isHittable && b.frame.height > 0 && b.frame.maxY <= app.frame.maxY
    }
    private var onList: Bool { app.staticTexts["Existing session 6"].firstMatch.isHittable }
    private var back: XCUIElement { app.buttons["Back"].firstMatch }
    private var field: XCUIElement { app.descendants(matching: .any).matching(identifier: "chat-composer-text").firstMatch }

    private func openExistingAndMeasure() -> (back: CGRect, field: CGRect) {
        app.staticTexts["Existing session 2"].firstMatch.tap()
        settle()
        XCTAssertTrue(back.waitForExistence(timeout: 3))
        let m = (back.frame, field.frame)
        back.tap(); settle()
        XCTAssertTrue(onList && tabBarVisible, "control: back to the list with its tab bar")
        return m
    }
    private func createViaPlus() {
        app.buttons["New Session"].firstMatch.tap()
        settle()
        app.buttons["Create"].firstMatch.tap()
        settle(2)
    }
    private func assertChatLayout(_ reference: (back: CGRect, field: CGRect), _ label: String) {
        XCTAssertEqual(back.frame.minY, reference.back.minY, accuracy: 1, "\(label): header below the status bar")
        if field.exists {
            XCTAssertEqual(field.frame.minY, reference.field.minY, accuracy: 1, "\(label): composer above the home indicator")
        }
        XCTAssertFalse(tabBarVisible, "\(label): no tab bar in the chat")
    }

    func testCreateFromPlusKeepsLayoutAndBackRestoresTabBar() {
        launch()
        let reference = openExistingAndMeasure()
        createViaPlus()
        assertChatLayout(reference, "created")
        back.tap(); settle()
        XCTAssertTrue(onList, "Back returns to the list")
        XCTAssertTrue(tabBarVisible, "tab bar returns with the list")
        XCTAssertEqual(app.cells.firstMatch.staticTexts["Pi"].exists, true, "the new Session is the first row")
    }

    func testPlaceholderPageHasCorrectLayoutAndSwipeBackRestoresTabBar() {
        launch(createDelayMs: 4_000)
        let reference = openExistingAndMeasure()
        createViaPlus()
        assertChatLayout(reference, "placeholder")
        settle(4)
        assertChatLayout(reference, "resolved")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        settle(1.5)
        XCTAssertTrue(onList)
        XCTAssertTrue(tabBarVisible)
    }

    func testCancellingTheSheetLeavesLaterPagesIntact() {
        launch()
        let reference = openExistingAndMeasure()
        app.buttons["New Session"].firstMatch.tap()
        settle()
        app.swipeDown(velocity: .fast)
        settle()
        XCTAssertTrue(tabBarVisible)
        app.staticTexts["Existing session 3"].firstMatch.tap()
        settle()
        assertChatLayout(reference, "after cancelled +")
    }
}
