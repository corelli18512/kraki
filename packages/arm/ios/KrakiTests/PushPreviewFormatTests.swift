import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

final class PushPreviewFormatTests: XCTestCase {
    private func content(_ object: [String: Any]) -> PushPreviewFormat.Content {
        let data = try! JSONSerialization.data(withJSONObject: object)
        return PushPreviewFormat.content(fromJSON: String(data: data, encoding: .utf8)!)
    }

    func testReplyUsesSessionTitleAndPlainBody() {
        let c = content(["type": "idle", "sessionId": "s1", "title": "Fix push", "summary": "Done. Tests pass."])
        XCTAssertEqual(c, .init(title: "Fix push", body: "Done. Tests pass.", category: "kraki.reply", sessionId: "s1"))
    }

    func testActionsLeadWithALabel() {
        XCTAssertEqual(content(["type": "permission", "title": "T", "summary": "Bash: rm -rf x"]).body, "Needs approval: Bash: rm -rf x")
        XCTAssertEqual(content(["type": "question", "title": "T", "summary": "Which one?"]).body, "Question: Which one?")
        XCTAssertEqual(content(["type": "error", "title": "T", "summary": "Agent request failed"]).body, "Failed: Agent request failed")
        XCTAssertEqual(content(["type": "error", "title": "T", "summary": "x"]).category, "kraki.failed")
    }

    func testReplyLessTurnDescribesSteps() {
        XCTAssertEqual(content(["type": "idle", "title": "T", "steps": 6]).body, "Finished with 6 steps and no reply.")
        XCTAssertEqual(content(["type": "idle", "title": "T", "steps": 1]).body, "Finished with 1 step and no reply.")
        XCTAssertEqual(content(["type": "idle", "title": "T"]).body, "Finished with no reply.")
    }

    func testMissingTitleAndGarbageFallBackToKraki() {
        XCTAssertEqual(content(["type": "idle", "summary": "hi"]).title, "Kraki")
        XCTAssertEqual(PushPreviewFormat.content(fromJSON: "not json").title, "Kraki")
    }

    func testEveryCategoryHasALockedPlaceholder() {
        let categories = Set(PushPreviewFormat.lockedPlaceholders.map(\.category))
        for type in ["idle", "permission", "question", "error"] {
            XCTAssertTrue(categories.contains(content(["type": type, "summary": "x"]).category), type)
        }
    }
}
