import XCTest

/// End-to-end against a LOCAL Kraki stack (scripts/dev-local.ts) with a real
/// agent. Runs only when TEST_RUNNER_KRAKI_E2E_SESSION is set (the driver
/// script creates the session and makes the agent ask).
final class QuestionE2EUITests: XCTestCase {
    private var shots = "/tmp/kraki-e2e-ios"

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: "\(shots)/\(name).png"))
    }

    private func launch() throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let session = env["KRAKI_E2E_SESSION"], !session.isEmpty else {
            throw XCTSkip("local E2E only")
        }
        shots = env["KRAKI_E2E_SHOTS"] ?? shots
        try? FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
        let app = XCUIApplication()
        app.launchEnvironment["KRAKI_LOCAL_RELAY_PORT"] = env["KRAKI_E2E_PORT"] ?? "4470"
        app.launchEnvironment["KRAKI_OPEN_SESSION_ID"] = session
        app.launch()
        let devLogin = app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Dev Login")).firstMatch
        if devLogin.waitForExistence(timeout: 8) { devLogin.tap() }
        return app
    }

    private func text(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    func testAnswerQuestionByTappingAChoice() throws {
        let app = try launch()
        let choice = app.buttons["Answer: Blue"]
        XCTAssertTrue(choice.waitForExistence(timeout: 40), "question choices visible")
        XCTAssertTrue(app.textFields["Type your answer…"].exists, "composer is in answer mode")
        sleep(1)
        shot("1-question")
        choice.tap()
        sleep(2)
        shot("2-answered")
        XCTAssertFalse(choice.exists, "choices go away once answered")
        XCTAssertTrue(text(app, "I will ask").exists, "the question bubble stays")
        XCTAssertTrue(text(app, "prefer Blue").waitForExistence(timeout: 90), "agent replies")
        sleep(2)
        shot("3-reply")
    }

    func testAnswerQuestionByTyping() throws {
        let app = try launch()
        let field = app.textFields["Type your answer…"]
        XCTAssertTrue(field.waitForExistence(timeout: 40), "composer is in answer mode")
        field.tap()
        field.typeText("Green, actually")
        shot("t1-typing")
        app.buttons["Submit answer"].tap()
        sleep(2)
        XCTAssertFalse(app.buttons["Answer: Red"].exists)
        XCTAssertTrue(text(app, "Green, actually").exists, "the typed answer is the user's bubble")
        XCTAssertTrue(text(app, "Green").waitForExistence(timeout: 90))
        sleep(6)
        shot("t2-reply")
    }

    func testAbortedQuestionReadsNotAnswered() throws {
        let app = try launch()
        XCTAssertTrue(app.buttons["Answer: Red"].waitForExistence(timeout: 40))
        // The driver script aborts the turn now.
        try "ready".write(toFile: "/tmp/kraki-e2e-abort-go", atomically: true, encoding: .utf8)
        let notAnswered = text(app, "Not answered").waitForExistence(timeout: 30)
        shot("a1-after-abort")
        XCTAssertTrue(notAnswered, "aborted question reads not answered")
        XCTAssertFalse(app.buttons["Answer: Red"].exists)
        sleep(1)
        shot("a1-not-answered")
    }
}
