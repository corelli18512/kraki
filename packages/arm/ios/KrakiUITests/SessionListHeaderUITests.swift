import XCTest

/// Real touches on the production Session list header (offline scenario
/// fixture with two computers): Liquid Glass Search and the native computer
/// Filter menu, in light and dark appearance. Screenshots are attached and,
/// with TEST_RUNNER_KRAKI_HEADER_SHOTS=<dir>, also written to disk.
final class SessionListHeaderUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.appearance = .light
    }

    private func launch(_ appearance: XCUIDevice.Appearance) {
        XCUIDevice.shared.appearance = appearance
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_IOS_NEW_SESSION_SCENARIO"] = "1"
        app.launchEnvironment["KRAKI_SCENARIO_SECOND_COMPUTER"] = "1"
        app.launch()
        XCTAssertTrue(searchButton.waitForExistence(timeout: 10))
    }

    private var searchButton: XCUIElement { app.buttons["session-list-search"] }
    private var filterButton: XCUIElement { app.buttons["session-list-filter"] }
    private var chip: XCUIElement { app.buttons["session-list-filter-chip"] }
    private var field: XCUIElement { app.textFields["session-list-search-field"] }
    private var rows: XCUIElementQuery { app.tables["session-list-table"].cells }

    private func settle(_ seconds: Double = 0.7) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["KRAKI_HEADER_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        }
    }

    func testSearchAndComputerFilterLight() { run(.light, "light") }
    func testSearchAndComputerFilterDark() { run(.dark, "dark") }

    private func run(_ appearance: XCUIDevice.Appearance, _ suffix: String) {
        launch(appearance)
        let all = rows.count
        XCTAssertEqual(all, 12, "six sessions on each computer")

        // Two 44 pt glass controls share the wordmark's row, 16 pt from the edge.
        XCTAssertEqual(searchButton.frame.height, 44, accuracy: 1)
        XCTAssertEqual(filterButton.frame.width, 44, accuracy: 1)
        XCTAssertEqual(searchButton.frame.midY, filterButton.frame.midY, accuracy: 0.5)
        XCTAssertEqual(app.frame.maxX - filterButton.frame.maxX, 16, accuracy: 1)
        XCTAssertGreaterThan(rows.element(boundBy: 0).frame.minY, filterButton.frame.maxY)
        XCTAssertTrue(app.staticTexts["KRAKI"].exists)
        XCTAssertFalse(app.staticTexts["Preview"].exists, "no Preview badge")
        settle()
        shot("01-rest-\(suffix)")

        let firstRowTop = rows.element(boundBy: 0).frame.minY
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)),
                    withVelocity: XCUIGestureVelocity(400), thenHoldForDuration: 0.3)
        settle(1.2)
        XCTAssertLessThan(rows.element(boundBy: 0).frame.minY, firstRowTop - 40, "rows scroll beneath the header")
        shot("02-scrolled-\(suffix)")
        app.tables["session-list-table"].swipeDown(velocity: .fast)
        settle(1.2)

        // Swipe offers only Pin and Unread (Fork lives in the Session's info sheet).
        rows.element(boundBy: 0).swipeLeft()
        XCTAssertTrue(app.buttons["Pin"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Mark as Unread"].exists)
        XCTAssertFalse(app.buttons["Fork"].exists)
        settle(0.5)
        shot("07-swipe-\(suffix)")
        app.buttons["Mark as Unread"].tap()
        settle(0.6)
        rows.element(boundBy: 0).swipeLeft()
        XCTAssertTrue(app.buttons["Mark as Read"].waitForExistence(timeout: 3), "title follows the row's state")
        settle(0.5)
        shot("08-swipe-unread-\(suffix)")
        app.buttons["Mark as Read"].tap()
        settle(0.6)

        // Search replaces the header row, focuses the field and filters live.
        searchButton.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "the field takes focus")
        XCTAssertFalse(searchButton.exists)
        field.typeText("existing-3")
        settle()
        XCTAssertEqual(rows.count, 1, "a Session ID finds its session")
        app.buttons["Clear Search"].tap()
        field.typeText("Existing session")
        settle()
        XCTAssertEqual(rows.count, 4, "only matching titles")
        shot("03-search-\(suffix)")
        field.typeText(" zzz")
        settle()
        XCTAssertTrue(app.staticTexts["No Results for \u{201C}Existing session zzz\u{201D}"].exists)
        shot("04-search-empty-\(suffix)")
        app.buttons["Clear Search"].tap()
        settle(0.4)
        XCTAssertEqual(rows.count, all, "clearing the text shows every session")
        app.buttons["session-list-search-close"].tap()
        XCTAssertTrue(searchButton.waitForExistence(timeout: 3), "closing restores the header")

        // Filter opens the native menu of computers.
        XCTAssertEqual(filterButton.label, "Filter by Computer")
        filterButton.tap()
        let server = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Build Server")).firstMatch
        XCTAssertTrue(server.waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "All Computers")).firstMatch.exists)
        settle(0.5)
        shot("05-filter-menu-\(suffix)")
        server.tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 3), "an active filter shows a removable chip")
        settle()
        XCTAssertEqual(rows.count, 6)
        XCTAssertEqual(filterButton.label, "Filter, showing Build Server")
        XCTAssertGreaterThan(rows.element(boundBy: 0).frame.minY, chip.frame.maxY)
        shot("06-filtered-\(suffix)")

        // Search stays within the chosen computer.
        searchButton.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText("existing")
        settle()
        XCTAssertEqual(rows.count, 0)
        app.buttons["session-list-search-close"].tap()
        settle(0.4)

        chip.tap()
        XCTAssertFalse(chip.waitForExistence(timeout: 1))
        settle()
        XCTAssertEqual(rows.count, all)
        XCTAssertEqual(filterButton.label, "Filter by Computer")
    }
}
