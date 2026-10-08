import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// Diag 2026-09-27 18:41:00 (Mac 0.2.40): one physical click (eventNumber
/// 7985, one down + one up) sent two answers (seq 90, 91). Symbolicated
/// stacks: one from the SwiftUI choice Button, one from MacChatScrollView's
/// local NSEvent monitor. In 0.2.40 the monitor was registered as
/// `self?.intercept(event) ?? event`, so a swallowed event (nil) was passed
/// on anyway and reached the Button too (fixed in 235b238a).
///
/// These gates drive the production MacChatView with a click delivered the
/// way AppKit delivers a real one (`NSApp.sendEvent`, through local
/// monitors), and pin that CommandSender takes one answer per open question
/// whatever the dispatch path.
@MainActor
final class MacQuestionAnswerOnceTests: MacChatUXTestCase {
    private var answers: [String] = []

    private func fixtureWithQuestion(accept: @escaping () -> Bool = { true }) throws -> Fx {
        let fx = try makeFixture(total: 20, outbound: { [weak self] msg in
            if msg["type"] as? String == "send_input",
               let p = msg["payload"] as? [String: Any], let to = p["answerTo"] as? String {
                self?.answers.append(to)
            }
            return accept()
        })
        drain(600)
        try startTurn(fx, seq: 21)
        try askQuestion(fx, seq: 22, choices: ["\u{5220}\u{6389}", "\u{5148}\u{4FDD}\u{7559}"])
        drain(1_200) // choice frames propagate asynchronously from SwiftUI
        return fx
    }

    private func choicePoint(_ fx: Fx, _ answer: String) throws -> NSPoint {
        for (_, cell) in fx.doc.automationVisibleCells {
            if let p = cell.automationChoiceWindowPoint(answer) { return p }
        }
        throw XCTSkip("choice frame not rendered")
    }

    private func click(_ fx: Fx, at point: NSPoint, viaApp: Bool, eventNumber: Int) throws {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(
                with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: fx.window.windowNumber,
                context: nil, eventNumber: eventNumber, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            if viaApp { NSApp.sendEvent(event) } else { fx.window.sendEvent(event) }
            drain(40)
        }
        drain(600)
    }

    /// The production path: NSApplication → local monitors → window.
    func testOneClickThroughNSApplicationAnswersOnce() throws {
        let fx = try fixtureWithQuestion()
        try click(fx, at: try choicePoint(fx, "\u{5220}\u{6389}"), viaApp: true, eventNumber: 7985)
        XCTAssertEqual(answers.count, 1, "one click must send exactly one answer")
    }

    func testOneClickThroughWindowOnlyAnswersOnce() throws {
        let fx = try fixtureWithQuestion()
        try click(fx, at: try choicePoint(fx, "\u{5220}\u{6389}"), viaApp: false, eventNumber: 7986)
        XCTAssertEqual(answers.count, 1)
    }

    /// Two dispatch paths for one click (as in 0.2.40) still send one answer.
    func testSecondAnswerToSameOpenQuestionIsDropped() throws {
        let fx = try fixtureWithQuestion()
        XCTAssertEqual(fx.app.commandSender?.answer(sessionId: sid, questionId: "q1", answer: "\u{5220}\u{6389}"), true)
        XCTAssertEqual(fx.app.commandSender?.answer(sessionId: sid, questionId: "q1", answer: "\u{5148}\u{4FDD}\u{7559}"), true)
        drain(300)
        XCTAssertEqual(answers.count, 1, "a second answer to the same open question must be dropped")
        XCTAssertEqual(fx.app.commandSender?.pendingInputs(sid).count, 1)
    }

    /// A failed answer does not block answering again.
    func testFailedAnswerCanBeAnsweredAgain() throws {
        var accept = true
        let fx = try fixtureWithQuestion(accept: { accept })
        let sender = try XCTUnwrap(fx.app.commandSender)
        _ = sender.answer(sessionId: sid, questionId: "q1", answer: "\u{5220}\u{6389}")
        drain(200)
        let first = try XCTUnwrap(sender.pendingInputs(sid).first)
        let clientId = try XCTUnwrap(first.payload["clientId"]?.stringValue)
        accept = false // transport refuses the manual retry → failed
        XCTAssertFalse(sender.retryPending(sessionId: sid, clientId: clientId))
        XCTAssertEqual(sender.pendingInputs(sid).first.map { sender.pendingState($0) }, .failed)
        accept = true
        _ = sender.answer(sessionId: sid, questionId: "q1", answer: "\u{5220}\u{6389}")
        drain(200)
        XCTAssertEqual(answers.count, 3, "first send, refused retry, then the new answer")
    }
}
