import XCTest

/// Subagent Steps against a LOCAL Kraki stack (scripts/dev-local.ts) with real
/// agents. Runs only when TEST_RUNNER_KRAKI_E2E_SUBAGENT_SESSIONS is set to
/// `agent=sessionId,…` (scripts/e2e/subagent-shots.ts creates the sessions).
/// For each session: open Steps, see the subagent card, open its page.
final class SubagentE2EUITests: XCTestCase {
    func testSubagentCardsOpenTheirOwnPage() throws {
        let env = ProcessInfo.processInfo.environment
        guard let spec = env["KRAKI_E2E_SUBAGENT_SESSIONS"], !spec.isEmpty else {
            throw XCTSkip("local E2E only")
        }
        let shots = env["KRAKI_E2E_SHOTS"] ?? "/tmp/kraki-e2e-ios-subagent"
        try? FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
        func shot(_ name: String) {
            try? XCUIScreen.main.screenshot().pngRepresentation
                .write(to: URL(fileURLWithPath: "\(shots)/\(name).png"))
        }
        for pair in spec.split(separator: ",") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            let (agent, session) = (parts[0], parts[1])
            let app = XCUIApplication()
            app.launchEnvironment["KRAKI_LOCAL_RELAY_PORT"] = env["KRAKI_E2E_PORT"] ?? "4480"
            app.launchEnvironment["KRAKI_OPEN_SESSION_ID"] = session
            app.launch()
            let devLogin = app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Dev Login")).firstMatch
            if devLogin.waitForExistence(timeout: 8) { devLogin.tap() }

            let steps = app.buttons.matching(NSPredicate(format: "label == %@", "Show steps"))
            XCTAssertTrue(steps.firstMatch.waitForExistence(timeout: 40), "\(agent): Steps button")
            sleep(2)
            shot("\(agent)-1-chat")
            steps.element(boundBy: steps.count - 1).tap()

            let card = app.buttons["subagent-card"].firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 20), "\(agent): subagent card in Steps")
            sleep(1)
            shot("\(agent)-2-steps")
            card.tap()

            let report = app.otherElements["subagent-report"].firstMatch
            let back = app.navigationBars.buttons["Steps"].firstMatch
            XCTAssertTrue(back.waitForExistence(timeout: 10), "\(agent): pushed subagent page")
            _ = report.waitForExistence(timeout: 10)
            sleep(2)
            shot("\(agent)-3-subagent")
            // Nested (pi parallel): one more level.
            let inner = app.buttons["subagent-card"].firstMatch
            if inner.exists {
                inner.tap()
                sleep(2)
                shot("\(agent)-4-nested")
                app.navigationBars.buttons.element(boundBy: 0).tap()
            }
            back.tap()
            XCTAssertTrue(card.waitForExistence(timeout: 5), "\(agent): back to Steps")
            app.terminate()
        }
    }
}
