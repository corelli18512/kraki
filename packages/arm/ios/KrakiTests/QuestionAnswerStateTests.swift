import XCTest
@testable import Kraki

/// 2-41 (review group 2, 2026-10-13): only an answer that may still be
/// delivered closes its question; a locally failed one leaves it open.
@MainActor
final class QuestionAnswerStateTests: XCTestCase {
    private func message(_ type: String, _ seq: Int, _ payload: [String: Any]) -> ChatMessage {
        ChatMessage(type: type, seq: seq, sessionId: "s", deviceId: nil, timestamp: nil,
                    payload: payload.mapValues(AnyCodable.init))
    }

    private let raw: [ChatMessage] = [
        ChatMessage(type: "user_message", seq: 1, sessionId: "s", deviceId: nil, timestamp: nil,
                    payload: ["content": AnyCodable("go")]),
        ChatMessage(type: "agent_message", seq: 2, sessionId: "s", deviceId: nil, timestamp: nil,
                    payload: ["content": AnyCodable("Two options."),
                              "question": AnyCodable(["id": "q1", "text": "Which?", "choices": ["A", "B"]])]),
    ]

    private func answer(state: String) -> ChatMessage {
        message("pending_input", 0, ["content": "A", "clientId": "c1", "answerTo": "q1", "localState": state])
    }

    func testFailedAnswerLeavesQuestionOpen() {
        let presented = ChatViewModel.presentingQuestions(raw, pending: [answer(state: "failed")], atHead: true)
        XCTAssertEqual(presented[1].questionPresentation?.state, .open)
    }

    func testInFlightAnswerStillClosesQuestion() {
        for state in ["sending", "correcting", "unconfirmed"] {
            let presented = ChatViewModel.presentingQuestions(raw, pending: [answer(state: state)], atHead: true)
            XCTAssertEqual(presented[1].questionPresentation?.state, .answered, state)
        }
    }
}
