import XCTest

/// The composer capsule behaves as one input target: every visible part
/// either focuses the TextField or belongs to a >= 44pt button.
final class ComposerHitAreaUITests: XCTestCase {
    private var app: XCUIApplication!
    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }
    private func launch() {
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_IOS_VOICE_HOLD_SCENARIO"] = "1"
        app.launch()
        XCTAssertTrue(mic.waitForExistence(timeout: 10))
    }
    private var mic: XCUIElement { app.buttons["chat-voice-microphone"] }
    private var send: XCUIElement { app.buttons["chat-send"] }
    private var attach: XCUIElement { app.buttons["Attach image"] }
    private var state: XCUIElement { app.staticTexts["voice-test-state"] }

    func testOneRowCapsuleButtonsMeetMinimumTouchTarget() {
        launch()
        for (name, element) in [("attach", attach), ("mic", mic), ("send", send)] {
            XCTAssertGreaterThanOrEqual(element.frame.width, 44, name)
            XCTAssertGreaterThanOrEqual(element.frame.height, 44, name)
        }
        XCTAssertEqual(mic.frame.height, 48, accuracy: 0.5, "one-row capsule height")
        XCTAssertEqual(attach.frame.midY, send.frame.midY, accuracy: 0.5)
        // Send sits outside the capsule, sized and spaced like the jump controls.
        XCTAssertEqual(send.frame.width, 44, accuracy: 0.5)
        XCTAssertEqual(send.frame.height, 44, accuracy: 0.5)
        XCTAssertEqual(app.frame.maxX - send.frame.maxX, 16, accuracy: 0.5, "same trailing column as ↓")
        XCTAssertEqual(send.frame.minX - (mic.frame.maxX + 2), 8, accuracy: 0.5, "8 pt from the capsule")
        XCTAssertLessThan(attach.frame.maxX, mic.frame.minX, "image, text, mic and send share one row")
        let item = XCTAttachment(screenshot: app.screenshot()); item.name = "composer-resting"; item.lifetime = .keepAlways; add(item)
    }

    func testJumpControlStaysPutAsComposerGrows() {
        launch()
        let jump = app.buttons["Jump to latest"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        let restingJump = jump.frame, restingSend = send.frame
        XCTAssertEqual(restingSend.minY - restingJump.maxY, 9, accuracy: 0.5, "8 pt + 1 pt balance for the bordered control")
        XCTAssertEqual(jump.frame.width, restingSend.width, accuracy: 0.5)
        mic.tap()
        let transcript = app.descendants(matching: .any).matching(identifier: "voice-transcript").firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 3))
        sleep(1)
        XCTAssertEqual(jump.frame.minY, restingJump.minY, accuracy: 0.5, "dictation must not push ↓ up")
        // The dictation box reaches exactly the top of the control above send
        // (transcript text starts 12 pt below the box top).
        // (A longer transcript may grow it further.)
        XCTAssertLessThanOrEqual(transcript.frame.minY - 12, restingJump.minY + 1, "box reaches at least the round control above")
        app.buttons["voice-cancel"].tap()
        let field = app.descendants(matching: .any).matching(identifier: "chat-composer-text").firstMatch
        field.tap(); field.typeText("one")
        sleep(1)
        let oneLine = jump.frame, oneLineField = field.frame
        field.typeText(" two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen")
        sleep(1)
        XCTAssertGreaterThan(field.frame.height, oneLineField.height + 10, "multi-line")
        XCTAssertEqual(jump.frame.minY, oneLine.minY, accuracy: 0.5, "multi-line text must not push ↓ up")
    }

    func testTapAnywhereInTextAreaFocusesField() {
        let probes: [(String, Bool, (CGRect, CGRect) -> CGPoint)] = [
            ("gap-after-image", false, { a, _ in CGPoint(x: a.maxX + 2, y: a.midY) }),
            ("gap-before-mic", false, { _, m in CGPoint(x: m.minX - 3, y: m.midY) }),
            ("top-edge", false, { a, m in CGPoint(x: (a.maxX + m.minX) / 2, y: a.minY + 3) }),
            ("bottom-edge", false, { a, m in CGPoint(x: (a.maxX + m.minX) / 2, y: a.maxY - 3) }),
            ("gap-after-image-with-draft", true, { a, _ in CGPoint(x: a.maxX + 2, y: a.midY) }),
        ]
        for (name, draft, point) in probes {
            launch()
            if draft { app.buttons["Seed draft"].tap() }
            let p = point(attach.frame, mic.frame)
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: p.x, dy: p.y)).tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "\(name) at \(p) did not focus")
            XCTAssertTrue(state.label.contains("starts=0"), "\(name): a tap must not record")
            app.terminate()
        }
    }
}
