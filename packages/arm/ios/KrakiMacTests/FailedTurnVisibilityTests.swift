import XCTest
@testable import Kraki_Dev

/// A turn that fails before any output must still say why in the chat
/// (e.g. "You've hit your usage limit…"), not only "Turn failed" in the sidebar.
@MainActor
final class FailedTurnVisibilityTests: XCTestCase {
    private func msg(_ type: String, _ seq: Int, _ payload: [String: AnyCodable]) -> ChatMessage {
        ChatMessage(type: type, seq: seq, sessionId: "s", deviceId: "d",
                    timestamp: "2026-09-30T00:00:00Z", payload: payload)
    }

    private func failed(_ seq: Int, message: String?) -> ChatMessage {
        var action: [String: Any] = ["type": "failed"]
        if let message { action["payload"] = ["message": message] }
        return msg("turn_status", seq, ["action": AnyCodable(action)])
    }

    func testDraftlessFailureWithAReasonIsShown() {
        let user = msg("user_message", 1, ["content": AnyCodable("hi")])
        let status = failed(2, message: "You've hit your usage limit.")
        XCTAssertFalse(ChatViewModel.shouldRender(status))
        XCTAssertEqual(ChatViewModel.renderable([user, status]).map(\.seq), [1, 2])
    }

    func testDraftlessFailureWithoutAReasonStaysHidden() {
        let user = msg("user_message", 1, ["content": AnyCodable("hi")])
        XCTAssertEqual(ChatViewModel.renderable([user, failed(2, message: nil)]).map(\.seq), [1])
    }

    func testUserAbortWithoutDraftShowsAStoppedRow() {
        let user = msg("user_message", 1, ["content": AnyCodable("hi")])
        let abort = msg("turn_status", 2, ["action": AnyCodable(["type": "user_abort"])])
        XCTAssertEqual(ChatViewModel.renderable([user, abort]).map(\.seq), [1, 2])
    }
}
