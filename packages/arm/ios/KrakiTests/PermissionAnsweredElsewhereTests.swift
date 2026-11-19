import XCTest
@testable import Kraki

/// K-345: a permission answered on two phones. The losing phone showed its
/// optimistic decision, then silently flipped to the other one.
@MainActor
final class PermissionAnsweredElsewhereTests: XCTestCase {
    private let sid = "perm-elsewhere"

    private func permission(decision: String? = nil) -> ChatMessage {
        var payload: [String: AnyCodable] = ["id": AnyCodable("p1"), "toolName": AnyCodable("shell"),
                                             "description": AnyCodable("Run: rm -rf build")]
        if let decision { payload["decision"] = AnyCodable(decision) }
        return ChatMessage(type: "permission", seq: 0, sessionId: nil, deviceId: nil, timestamp: nil, payload: payload)
    }

    private func makeStore() -> MessageStore {
        let store = MessageStore(db: MessageDatabase(inMemory: ()))
        store.beginCardTurn(sid)
        store.applyCardAction(sid, permission())
        return store
    }

    func testOtherDevicesDifferentDecisionIsExplained() {
        let store = makeStore()
        store.applyLocalResolution(sid, promptId: "p1", decision: "deny")
        store.applyCardAction(sid, permission(decision: "approve"))
        let action = store.cards[sid]?.action
        XCTAssertEqual(action?.payload["decision"]?.stringValue, "approve")
        XCTAssertEqual(action?.payload["localError"]?.stringValue, "Already answered on another device.")
        XCTAssertNil(action?.payload["localPending"])
    }

    func testOwnConfirmedDecisionHasNoNote() {
        let store = makeStore()
        store.applyLocalResolution(sid, promptId: "p1", decision: "deny")
        store.applyCardAction(sid, permission(decision: "deny"))
        XCTAssertNil(store.cards[sid]?.action?.payload["localError"])
    }
}
