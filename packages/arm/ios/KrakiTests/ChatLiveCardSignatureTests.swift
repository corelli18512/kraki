import XCTest
@testable import Kraki

#if os(iOS)
/// `ChatPerfListVC.liveCardSignature` gates the live bubble's reconfigure and
/// its content memo, so every rendered action field must change it (parity
/// with the Mac `liveCardSignature`).
@MainActor
final class ChatLiveCardSignatureTests: XCTestCase {
    private func card(_ type: String, _ payload: [String: AnyCodable], text: String = "Same draft.")
        -> MessageStore.SessionCard {
        MessageStore.SessionCard(text: text, action: ChatMessage(
            type: type, seq: 0, sessionId: "s", deviceId: "d", timestamp: nil, payload: payload))
    }

    private func signature(_ card: MessageStore.SessionCard) -> String {
        ChatPerfListVC.liveCardSignature(of: card)
    }

    func testParallelToolCountChangesTheSignature() {
        XCTAssertNotEqual(signature(card("tool_batch", ["running": 3])),
                          signature(card("tool_batch", ["running": 2])))
    }

    func testOtherRenderedActionFieldsChangeTheSignature() {
        let changes: [(String, String, AnyCodable, AnyCodable)] = [
            ("tool_start", "toolName", "old_tool", "new_tool"),
            ("tool_start", "headline", "Old headline", "New headline"),
            ("permission", "description", "Old description", "New description"),
            ("permission", "args", AnyCodable(["command": "pwd"]), AnyCodable(["command": "ls"])),
            ("question", "choices", AnyCodable(["Before"]), AnyCodable(["After"])),
            ("failed", "message", "Old failure", "New failure"),
            ("tool_complete", "success", true, false),
        ]
        for (type, key, old, new) in changes {
            XCTAssertNotEqual(signature(card(type, [key: old])), signature(card(type, [key: new])),
                              "\(type).\(key)")
        }
    }

    func testUnchangedCardKeepsTheSignature() {
        XCTAssertEqual(signature(card("tool_batch", ["running": 3])),
                       signature(card("tool_batch", ["running": 3])))
    }
}

extension ChatUXRegressionTests {
    /// The visible live cell must follow a `tool_batch` 3 → 2 change while the
    /// draft text stays the same (the Mac O01 symptom fixed in #570).
    func testParallelToolCountUpdatesTheLiveCellWithoutTextChange() throws {
        let fx = try makeFixture(total: 30)
        drain(400)
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageStore.applyCardMessage(sid, "Checking the three packages.", reset: true)
        func batch(_ running: Int) -> ChatMessage {
            ChatMessage(type: "tool_batch", seq: 0, sessionId: sid, deviceId: dev,
                        timestamp: "2026-10-15T00:00:00Z", payload: ["running": AnyCodable(running)])
        }
        func liveRunning() throws -> Int? {
            fx.cv.layoutIfNeeded()
            let cell = try XCTUnwrap(fx.cv.visibleCells.compactMap { $0 as? TKBubbleCell }
                .first { $0.contentSnapshot?.action?.type == "tool_batch" })
            return cell.contentSnapshot?.action?.payload["running"]?.intValue
        }
        fx.app.messageStore.applyCardAction(sid, batch(3))
        fx.vc.syncLiveUpdates(); drain(300)
        XCTAssertEqual(try liveRunning(), 3)
        fx.app.messageStore.applyCardAction(sid, batch(2))
        fx.vc.syncLiveUpdates(); drain(300)
        XCTAssertEqual(try liveRunning(), 2, "the live cell must re-render the new running count")
    }
}
#endif
