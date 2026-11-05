import XCTest
@testable import Kraki

#if os(iOS)
/// How an open question's bubble closes in the live list.
extension ChatUXRegressionTests {
    private func spine(_ fx: Fx, _ object: [String: Any]) throws {
        fx.app.messageProvider?.ingestTailCandidate(sid, json: try JSONSerialization.data(withJSONObject: object))
        fx.vc.syncLiveUpdates()
    }

    private func openQuestion(_ fx: Fx) throws {
        fx.app.messageStore.beginCardTurn(sid)
        try spine(fx, ["type": "user_message", "seq": 11, "sessionId": sid, "deviceId": dev,
                       "timestamp": "2026-09-01T00:00:01.000Z", "payload": ["content": "pick one"]])
        try spine(fx, ["type": "agent_message", "seq": 12, "sessionId": sid, "deviceId": dev,
                       "timestamp": "2026-09-01T00:00:03.000Z",
                       "payload": ["content": "Two options.", "question": ["id": "q1", "text": "Which?", "choices": ["A", "B"]]]])
        drain(300)
        XCTAssertTrue(fx.vc.automationItemIDs.contains("\(sid):12#q-open"))
    }

    /// K-168: the choices fade into the answered state, not vanish in a frame.
    func testAnsweredQuestionChoicesFadeOut() throws {
        let fx = try makeFixture(total: 10)
        drain(600)
        try openQuestion(fx)
        XCTAssertTrue(fx.app.commandSender?.answer(sessionId: sid, questionId: "q1", answer: "A") == true)
        fx.vc.syncLiveUpdates()
        let index = try XCTUnwrap(fx.vc.automationItemIDs.firstIndex(of: "\(sid):12"))
        let cell = try XCTUnwrap(fx.cv.cellForItem(at: IndexPath(item: index, section: 0)))
        let fade = try XCTUnwrap(cell.layer.animation(forKey: kCATransition) as? CATransition, "choices vanish in one frame")
        XCTAssertEqual(fade.type, .fade)
    }
}
#endif
