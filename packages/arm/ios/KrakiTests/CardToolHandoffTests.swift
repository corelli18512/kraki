import XCTest
@testable import Kraki

/// K-064: tool → words handoff. Older Tentacles clear the slot just before
/// the delta that replaces the narration; the chip dropped a frame early, or a
/// tool-only bubble vanished and slid in again. Current Tentacles send the
/// words first, and the clear that follows must then simply apply.
@MainActor
final class CardToolHandoffTests: XCTestCase {
    private let sid = "tool-handoff"

    private func toolDone(_ id: String) -> ChatMessage {
        ChatMessage(type: "tool_complete", seq: 0, sessionId: nil, deviceId: nil, timestamp: nil,
                    payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable(id), "success": AnyCodable(true)])
    }

    private func makeStore() -> MessageStore {
        let store = MessageStore(db: MessageDatabase(inMemory: ()))
        store.beginCardTurn(sid)
        return store
    }

    func testToolOnlyBubbleSurvivesTheEarlyClear() {
        let store = makeStore()
        store.applyCardAction(sid, toolDone("t1"))
        store.applyCardAction(sid, nil)
        XCTAssertEqual(store.cards[sid]?.action?.toolCallId, "t1", "the bubble keeps its chip until the words arrive")
        store.applyCardMessage(sid, "Here is the listing", reset: true)
        XCTAssertNil(store.cards[sid]?.action)
        XCTAssertEqual(store.cards[sid]?.text, "Here is the listing")
    }

    func testChipStaysWithTheOldNarrationUntilTheNewSegment() {
        let store = makeStore()
        store.applyCardMessage(sid, "Checking the repo", reset: true)
        store.applyCardAction(sid, toolDone("t1"))
        store.applyCardAction(sid, nil)
        XCTAssertEqual(store.cards[sid]?.text, "Checking the repo")
        XCTAssertNotNil(store.cards[sid]?.action, "no frame with the old narration and no chip")
        store.applyCardMessage(sid, "Found it", reset: true)
        XCTAssertNil(store.cards[sid]?.action)
    }

    func testClearAfterTheNewWordsApplies() {
        let store = makeStore()
        store.applyCardMessage(sid, "Checking the repo", reset: true)
        store.applyCardAction(sid, toolDone("t1"))
        store.applyCardMessage(sid, "Found it", reset: true)
        XCTAssertNotNil(store.cards[sid]?.action)
        store.applyCardAction(sid, nil)
        XCTAssertNil(store.cards[sid]?.action, "words came first: the clear is not held back")
    }
}
