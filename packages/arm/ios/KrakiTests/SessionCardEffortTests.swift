import XCTest
@testable import Kraki

@MainActor
final class SessionCardEffortTests: XCTestCase {
    private func session(model: String? = "gpt-5", effort: ReasoningEffort? = .high) -> SessionInfo {
        SessionInfo(
            id: "effort-card", deviceId: "dev", deviceName: "mac", agent: "pi",
            model: model, reasoningEffort: effort, title: "Effort test",
            state: .idle, mode: .safe, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000), pinned: false
        )
    }

    private func project(_ session: SessionInfo) -> SessionCardProjection {
        SessionCardProjection.make(session: session, device: nil, preview: nil, draft: nil)
    }

    func testDisplaysOnlyAuthoritativeEffortAndKeepsModelUnchanged() {
        for effort: ReasoningEffort in [.low, .medium, .high, .xhigh, .max] {
            let card = project(session(effort: effort))
            XCTAssertEqual(card.model, "gpt-5")
            XCTAssertEqual(card.effortLabel, effort.rawValue)
        }
        XCTAssertNil(project(session(effort: nil)).effortLabel, "old sessions must not invent an effort")
        XCTAssertNil(project(session(model: nil)).effortLabel)
        XCTAssertNil(project(session(model: "")).effortLabel)
    }

    func testEffortOnlyUpdateReconfiguresIOSCard() {
        let store = SessionStore(persistenceEnabled: false)
        var item = session()
        store.upsertSession(item)
        func fingerprint(_ value: SessionInfo) -> Int {
            SessionTableController.fingerprint(
                for: value, store: store, device: nil,
                isAwaitingGreeting: false, isCompacting: false
            )
        }
        let high = fingerprint(item)
        let highProjection = project(item)
        item.reasoningEffort = .low
        XCTAssertNotEqual(fingerprint(item), high, "same model/seq/preview, only effort changed")
        XCTAssertNotEqual(project(item), highProjection)
        item.reasoningEffort = nil
        XCTAssertNotEqual(fingerprint(item), high, "clearing effort must remove the label")
        item.reasoningEffort = .high
        XCTAssertEqual(fingerprint(item), high)
    }

    func testSameModelAcknowledgementAndDigestRefreshUpdateCard() throws {
        let store = SessionStore(persistenceEnabled: false)
        store.upsertSession(session())
        for effort: ReasoningEffort in [.low, .high] {
            // MessageRouter uses this entry point for session_model_set.
            store.setSessionModel("effort-card", model: "gpt-5", reasoningEffort: effort)
            let item = try XCTUnwrap(store.sessions["effort-card"])
            XCTAssertEqual(project(item).effortLabel, effort.rawValue)
            XCTAssertEqual(item.model, "gpt-5")
        }
        let digest = SessionDigest(
            id: "effort-card", agent: "pi", model: "gpt-5", reasoningEffort: .max,
            state: .idle, mode: .safe, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: "2024-01-01T00:00:00.000Z"
        )
        store.upsertSession(digest, deviceId: "dev", deviceName: "mac")
        let updated = try XCTUnwrap(store.sessions["effort-card"])
        XCTAssertEqual(project(updated).effortLabel, "max")
        let restored = try JSONDecoder().decode(SessionInfo.self, from: JSONEncoder().encode(updated))
        XCTAssertEqual(project(restored).effortLabel, "max")
        store.setSessionModel("effort-card", model: "gpt-5", reasoningEffort: nil)
        XCTAssertNil(project(try XCTUnwrap(store.sessions["effort-card"])).effortLabel)
    }
}
