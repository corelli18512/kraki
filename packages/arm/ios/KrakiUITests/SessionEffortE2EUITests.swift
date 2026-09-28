import XCTest

/// Local Head + real Pi harness: scripts/e2e/session-effort.ts. No LLM turn.
/// TEST_RUNNER_KRAKI_EFFORT_SESSION / PORT / MODEL opt into this test.
final class SessionEffortE2EUITests: XCTestCase {
    func testPickerChangesEffortWithoutChangingModelAndRefreshesCard() throws {
        let env = ProcessInfo.processInfo.environment
        guard let session = env["KRAKI_EFFORT_SESSION"],
              let port = env["KRAKI_EFFORT_PORT"], let model = env["KRAKI_EFFORT_MODEL"] else {
            throw XCTSkip("isolated local effort E2E only")
        }
        let app = XCUIApplication()
        app.launchEnvironment["KRAKI_LOCAL_RELAY_PORT"] = port
        app.launch()
        let login = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Dev Login")).firstMatch
        if login.waitForExistence(timeout: 8) { login.tap() }
        let effort = app.staticTexts["session-effort-\(session)"]
        XCTAssertTrue(effort.waitForExistence(timeout: 40))
        assertEffort(effort, "high")
        shot("ios-initial-high")

        for level in ["Low", "High"] {
            app.staticTexts["Effort Sync E2E"].firstMatch.tap()
            let title = app.buttons["Effort Sync E2E"]
            XCTAssertTrue(title.waitForExistence(timeout: 10))
            title.tap()
            let modelRow = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", model)).firstMatch
            XCTAssertTrue(modelRow.waitForExistence(timeout: 10))
            modelRow.tap()
            let segment = app.segmentedControls.buttons[level]
            XCTAssertTrue(segment.waitForExistence(timeout: 10))
            segment.tap()
            shot("ios-picker-\(level.lowercased())")
            // Dismiss the real sheet by dragging its navigation bar down.
            let nav = app.navigationBars["Model"]
            let start = nav.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 650)))
            let back = app.buttons["Back"].firstMatch
            XCTAssertTrue(back.waitForExistence(timeout: 10))
            back.tap()
            XCTAssertTrue(effort.waitForExistence(timeout: 10))
            assertEffort(effort, level.lowercased())
            XCTAssertTrue(app.staticTexts[model].exists, "model unchanged after effort-only edit")
            shot("ios-card-\(level.lowercased())")
        }

        if let dir = env["KRAKI_EFFORT_REMOTE_DIR"] {
            // The Mac driver chooses Low while THIS reused card remains visible.
            try "ready".write(toFile: "\(dir)/ios-awaiting-remote-low", atomically: true, encoding: .utf8)
            assertEffort(effort, "low", timeout: 90)
            shot("ios-live-remote-low")
            XCTAssertTrue(app.staticTexts[model].exists)
        }
    }

    private func assertEffort(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 20) {
        let predicate = NSPredicate(format: "label == %@", "Reasoning effort: \(value)")
        XCTAssertTrue(element.waitForExistence(timeout: timeout))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout), .completed)
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["KRAKI_EFFORT_REMOTE_DIR"] {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        }
    }
}
