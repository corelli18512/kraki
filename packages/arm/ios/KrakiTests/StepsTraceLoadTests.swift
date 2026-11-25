import XCTest
@testable import Kraki

/// Steps sheet loading: what it shows while a trace is missing (K-015) and
/// whether a re-pulled old turn's trace is kept to be shown (K-052).
@MainActor
final class StepsTraceLoadTests: XCTestCase {
    private let step = ChatMessage(type: "tool_complete", seq: 9001, sessionId: "s", deviceId: "d", timestamp: nil,
                                   payload: ["toolName": AnyCodable("bash")])

    func testUnansweredTraceRequestEndsInAnErrorInsteadOfLoadingForever() {
        XCTAssertEqual(StepsLoadPhase.of(nil, live: false, timedOut: false), .loading)
        XCTAssertEqual(StepsLoadPhase.of(nil, live: false, timedOut: true), .failed)
        XCTAssertEqual(StepsLoadPhase.of(nil, live: true, timedOut: true), .failed)
    }

    func testEmptyTraceOfAConcludedTurnSaysSo() {
        XCTAssertEqual(StepsLoadPhase.of([], live: false, timedOut: false), .empty)
        XCTAssertEqual(StepsLoadPhase.of([], live: false, timedOut: true), .empty)
        // A running turn may have no steps yet.
        XCTAssertEqual(StepsLoadPhase.of([], live: true, timedOut: false), .loading)
        XCTAssertEqual(StepsLoadPhase.of([step], live: false, timedOut: true), .loaded)
    }

    func testRepulledOldTurnTraceIsKeptWhenTheCacheIsFull() throws {
        let store = MessageStore(db: MessageDatabase(inMemory: ()))
        let sid = "steps-cache"
        let newest = MessageStore.maxTracesPerSession + 6
        for seq in 7...newest { store.setTurnSteps(sid, bubbleSeq: seq, [step]) }
        XCTAssertNil(store.turnSteps(sid, bubbleSeq: 1))
        // The user opens Steps of an old turn: its re-pull must be shown.
        store.setTurnSteps(sid, bubbleSeq: 1, [step])
        XCTAssertEqual(store.turnSteps(sid, bubbleSeq: 1)?.count, 1)
        XCTAssertEqual(store.traces[sid]?.count, MessageStore.maxTracesPerSession)
        XCTAssertNil(store.turnSteps(sid, bubbleSeq: 7), "the oldest other turn is dropped instead")
    }
}
