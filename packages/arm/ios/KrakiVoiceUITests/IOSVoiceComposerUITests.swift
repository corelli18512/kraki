import XCTest

/// Real ChatView + MessageInputView against a synthetic voice engine and a
/// captured transport (see IOSVoiceHoldScenario). Nothing leaves the device.
final class IOSVoiceComposerUITests: XCTestCase {
    private var app: XCUIApplication!
    private let spoken = "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki \u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}"
    private let corrected = "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki\u{FF0C}\u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}\u{3002}"

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        launch()
    }
    private func launch(dark: Bool = false, finalMs: Int = 3500) {
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_IOS_VOICE_HOLD_SCENARIO"] = "1"
        app.launchEnvironment["KRAKI_VOICE_TEST_SCREENSHOTS"] = "1"
        app.launchEnvironment["KRAKI_VOICE_TEST_FINAL_MS"] = String(finalMs)
        if dark { app.launchEnvironment["KRAKI_VOICE_TEST_DARK"] = "1" }
        app.launch()
        XCTAssertTrue(mic.waitForExistence(timeout: 10))
    }
    private var mic: XCUIElement { app.buttons["chat-voice-microphone"] }
    private var field: XCUIElement { app.descendants(matching: .any).matching(identifier: "chat-composer-text").firstMatch }
    private var transcript: XCUIElement { app.descendants(matching: .any).matching(identifier: "voice-transcript").firstMatch }
    private var state: XCUIElement { app.staticTexts["voice-test-state"] }
    private var fieldValue: String { field.value as? String ?? "" }
    private func awaitState(_ value: String, timeout: TimeInterval = 8) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", value), object: state)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed, state.label)
    }
    private func awaitTranscript() {
        let heard = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS 'Kraki'"), object: transcript)
        XCTAssertEqual(XCTWaiter.wait(for: [heard], timeout: 5), .completed, transcript.label)
    }
    private func screenshot(_ name: String) {
        let item = XCTAttachment(screenshot: app.screenshot()); item.name = name; item.lifetime = .keepAlways; add(item)
    }
    private func bubble(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND NOT (identifier IN {'voice-test-sent', 'chat-composer-text', 'voice-transcript'})", text)).firstMatch
    }

    func testTapSendCollapsesAtOnceCorrectsInBubbleAndSendsOnce() {
        launch(finalMs: 7000)   // keep the correcting window observable
        let resting = mic.frame
        mic.tap()
        awaitState("rec=1")
        XCTAssertTrue(app.buttons["voice-send"].exists && app.buttons["voice-cancel"].exists && app.buttons["voice-to-text"].exists)
        awaitTranscript()
        screenshot("recording-two-rows")
        app.buttons["voice-send"].tap()
        awaitState("rec=0", timeout: 2)
        awaitState("staged=1", timeout: 2)
        awaitState("sent=0")
        XCTAssertTrue(mic.waitForExistence(timeout: 2))
        XCTAssertEqual(mic.frame.height, resting.height, accuracy: 0.5, "composer back to one row immediately")
        XCTAssertEqual(fieldValue.contains("Kraki"), false, "composer is cleared for the next message")
        XCTAssertTrue(bubble(containing: "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}").waitForExistence(timeout: 2), "the sent message shows as a bubble at once")
        screenshot("bubble-correcting")
        awaitState("staged=1")
        awaitState("staged=0", timeout: 10)
        awaitState("sent=1")
        XCTAssertEqual(app.staticTexts["voice-test-sent"].label, corrected, "the agent receives the corrected text")
        screenshot("correction-complete-transport-captured")
        sleep(1)
        awaitState("sent=1")
    }

    func testCancelDiscardsUtteranceAndRestoresComposer() {
        let resting = mic.frame
        mic.tap()
        awaitTranscript()
        app.buttons["voice-cancel"].tap()
        awaitState("rec=0")
        awaitState("finishing=0")
        XCTAssertEqual(mic.frame, resting)
        XCTAssertFalse(fieldValue.contains("Kraki"))
        sleep(4)
        awaitState("sent=0")
        awaitState("staged=0")
        XCTAssertFalse(fieldValue.contains("Kraki"), "a late result cannot resurrect a cancelled utterance")
    }

    func testEditPutsTextInFieldAndTypingWinsOverLateCorrection() {
        mic.tap()
        awaitTranscript()
        app.buttons["voice-to-text"].tap()
        awaitState("rec=0")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(fieldValue.contains("Kraki"), fieldValue)
        field.typeText(" human")
        awaitState("finishing=0", timeout: 8)
        XCTAssertTrue(fieldValue.contains(" human"), fieldValue)
        XCTAssertFalse(fieldValue.contains("Kraki\u{FF0C}"), "late correction must not overwrite typing")
        awaitState("sent=0")
        screenshot("edit-native-field")
    }

    func testEditWithoutTypingReceivesCorrection() {
        mic.tap()
        awaitTranscript()
        app.buttons["voice-to-text"].tap()
        awaitState("finishing=0", timeout: 8)
        XCTAssertEqual(fieldValue, corrected)
        awaitState("sent=0")
    }

    func testContinuationInsertsAtCaretAndSendsWholeDraft() {
        app.buttons["Seed draft"].tap()
        field.tap()
        mic.tap()
        awaitTranscript()
        XCTAssertTrue(transcript.label.contains("Prefix"), "the existing draft is shown around the new speech")
        app.buttons["voice-send"].tap()
        awaitState("sent=1", timeout: 10)
        let sent = app.staticTexts["voice-test-sent"].label
        XCTAssertTrue(sent.contains(corrected), sent)
        XCTAssertEqual(sent.replacingOccurrences(of: corrected, with: ""), "Prefix SUFFIX", sent)
    }

    func testNativeSelectAllThenDictateReplacesSelection() {
        app.buttons["Seed draft"].tap()
        field.tap()
        field.press(forDuration: 0.8)
        let selectAll = app.menuItems["Select All"].exists ? app.menuItems["Select All"] : app.buttons["Select All"]
        XCTAssertTrue(selectAll.waitForExistence(timeout: 3))
        selectAll.tap()
        mic.tap()
        awaitTranscript()
        app.buttons["voice-to-text"].tap()
        awaitState("finishing=0", timeout: 8)
        XCTAssertEqual(fieldValue, corrected)
    }

    func testLeavingWhileRecordingKeepsSpeechAsDraftOfOrigin() {
        mic.tap()
        awaitTranscript()
        app.buttons["Switch"].tap()
        awaitState("session=voice-b")
        awaitState("rec=0")
        XCTAssertFalse(fieldValue.contains("Kraki"))
        awaitState("finishing=0", timeout: 8)
        app.buttons["Switch"].tap()
        awaitState("session=voice-a")
        XCTAssertTrue(fieldValue.contains("Kraki"), fieldValue)
        awaitState("sent=0")
    }

    func testRunningAgentShowsStopUntilSomethingIsTyped() {
        app.buttons["Busy"].tap()
        let stop = app.buttons["chat-stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 3))
        let stopFrame = stop.frame
        field.tap(); field.typeText("\u{5148}\u{522B}\u{52A8}\u{6CE8}\u{518C}\u{9875}")
        let send = app.buttons["chat-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 2))
        XCTAssertFalse(stop.exists)
        XCTAssertEqual(send.frame.midX, stopFrame.midX, accuracy: 0.5, "Stop turns into Send in place")
        XCTAssertEqual(send.label, "Steer agent")
        app.buttons["chat-clear"].tap()
        XCTAssertTrue(stop.waitForExistence(timeout: 2), "clearing turns it back into Stop")
        XCTAssertEqual(fieldValue.contains("\u{5148}\u{522B}\u{52A8}"), false)
        stop.tap()
        awaitState("aborts=1")
        screenshot("running-stop")
    }

    func testLandscapeRecordingCancel() {
        XCUIDevice.shared.orientation = .landscapeLeft
        let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.app.frame.width > self.app.frame.height }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 5), .completed)
        mic.tap()
        awaitTranscript()
        screenshot("landscape-recording")
        app.buttons["voice-cancel"].tap()
        awaitState("rec=0")
        awaitState("sent=0")
        XCUIDevice.shared.orientation = .portrait
    }

    func testDarkRecordingAndCorrectingBubble() {
        launch(dark: true)
        awaitState("appearance=dark")
        mic.tap()
        awaitTranscript()
        screenshot("dark-recording")
        app.buttons["voice-send"].tap()
        awaitState("staged=1", timeout: 2)
        screenshot("dark-bubble-correcting")
        awaitState("sent=1", timeout: 10)
    }

    func testVoiceAnswerToAQuestionCorrectsInTheBubbleLikeAMessage() {
        launch(finalMs: 7000)
        app.buttons["Ask"].tap()
        let answerPlaceholder = app.descendants(matching: .any).matching(NSPredicate(format: "placeholderValue == 'Type your answer…'")).firstMatch
        XCTAssertTrue(answerPlaceholder.waitForExistence(timeout: 5), "composer is answering the question")
        mic.tap()
        awaitTranscript()
        app.buttons["voice-send"].tap()
        awaitState("rec=0", timeout: 2)
        awaitState("staged=1", timeout: 2)
        awaitState("sent=0")
        XCTAssertFalse(fieldValue.contains("Kraki"), "composer cleared at once, like a normal send")
        XCTAssertTrue(bubble(containing: "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}").waitForExistence(timeout: 2), "the answer is a correcting bubble")
        screenshot("answer-bubble-correcting")
        awaitState("sent=1", timeout: 10)
        XCTAssertEqual(app.staticTexts["voice-test-sent"].label, corrected)
        XCTAssertTrue(app.staticTexts["voice-test-answer"].label.hasPrefix("answerTo=q-"), "sent as the question's answer")
        sleep(1)
        screenshot("answer-sent")
    }

    // MARK: Backgrounding while a sent voice message is being corrected
    // (diag 2026-09-28: such messages stayed "not delivered" until a manual
    // Retry 4 and 16 minutes later). Real background transitions (Home).

    private func sendAndGoHome() {
        mic.tap()
        awaitTranscript()
        app.buttons["voice-send"].tap()
        awaitState("staged=1", timeout: 2)
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5) || app.state == .runningBackgroundSuspended)
    }

    func testBackgroundRightAfterSendStillDeliversCorrectedText() {
        launch(finalMs: 2500)
        sendAndGoHome()
        sleep(6)                    // the correction finishes while in the background
        app.activate()
        awaitState("sent=1", timeout: 2)
        awaitState("bgSent=1")      // delivered while backgrounded, not after returning
        awaitState("staged=0")
        awaitState("failed=0")
        XCTAssertEqual(app.staticTexts["voice-test-sent"].label, corrected)
    }

    func testBackgroundBriefReturnSendsOnce() {
        launch(finalMs: 4000)
        sendAndGoHome()
        sleep(1)
        app.activate()             // back before the correction: nothing was torn down
        awaitState("sent=1", timeout: 8)
        awaitState("bgSent=0")
        sleep(2)
        awaitState("sent=1")
        awaitState("failed=0")
    }

    func testCorrectionTooSlowInBackgroundKeepsTheMessageNotDelivered() {
        launch(finalMs: 20_000)     // longer than the background grace period
        sendAndGoHome()
        sleep(13)
        app.activate()
        awaitState("staged=0", timeout: 3)
        awaitState("failed=1")
        awaitState("sent=0")
        XCTAssertTrue(app.descendants(matching: .any)["Not delivered. Tap to retry"].waitForExistence(timeout: 3)
                      || app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Not delivered'")).firstMatch.exists,
                      "kept as a retryable bubble, never silently sent")
    }
}
