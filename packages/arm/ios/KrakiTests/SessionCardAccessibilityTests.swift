#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// K-343 (card VoiceOver output) and K-177 (computer-rendered preview copy).
@MainActor
final class SessionCardAccessibilityTests: XCTestCase {
    private var tree: AccessibilityTreeHost?

    override func tearDown() {
        tree?.tearDown()
        tree = nil
        super.tearDown()
    }

    private func session(id: String = "a11y-card", effort: ReasoningEffort? = nil) -> SessionInfo {
        SessionInfo(
            id: id, deviceId: "dev", deviceName: "mac", agent: "pi",
            model: "gpt-5", reasoningEffort: effort, title: "Card a11y",
            state: .idle, mode: .safe, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000), pinned: false
        )
    }

    // MARK: K-343

    func testDraftCardIsNotReadAsLastMessageFromYou() {
        let draft = SessionCardProjection.make(
            session: session(), device: nil,
            preview: SessionPreview(text: "earlier", type: "user", timestamp: "2026-09-26T12:00:00.000Z"),
            draft: "half-typed")
        XCTAssertEqual(draft.status, .humanMessage, "the draft keeps its glyph slot")
        XCTAssertEqual(draft.statusAccessibilityLabel, "Draft")

        let sent = SessionCardProjection.make(
            session: session(), device: nil,
            preview: SessionPreview(text: "earlier", type: "user", timestamp: "2026-09-26T12:00:00.000Z"),
            draft: nil)
        XCTAssertEqual(sent.statusAccessibilityLabel, "Last message from you")
        XCTAssertEqual(SessionCardStatus.humanMessage.accessibilityLabel(isDraft: true), "Draft")
    }

    func testCardWithoutEffortExposesNoEmptyEffortElement() throws {
        try requireForegroundUITests()
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let app = AppState.makeUnitTestHost()
        app.sessionStore.upsertSession(session(id: "no-effort"))
        app.sessionStore.upsertSession(session(id: "with-effort", effort: .high))
        app.sessionStore.sessionPreviews["no-effort"] = SessionPreview(text: "hi", type: "user", timestamp: "2026-09-26T12:00:00.000Z")
        _ = try tree.show(VStack {
            SessionCardView(sessionId: "no-effort")
            SessionCardView(sessionId: "with-effort")
        }.environment(app))

        let elements = tree.elements()
        let described = tree.describeElements()
        XCTAssertEqual(elements.filter { $0.accessibilityLabel == "Reasoning effort: high" }.count, 1, "\(described)")
        let empty = elements.filter { ($0.accessibilityLabel ?? "").isEmpty }
        XCTAssertTrue(empty.isEmpty, "unlabeled elements: \(described)")
        // The status glyph is decorative: its status is part of the preview's label.
        XCTAssertFalse(elements.contains { $0.accessibilityLabel == "Last message from you" }, "\(described)")
        XCTAssertEqual(elements.filter { $0.accessibilityLabel == "Last message from you: hi" }.count, 1, "\(described)")
    }

    // MARK: K-177

    func testComputerRenderedTerminalPreviewFollowsAppLanguage() {
        let zh = Locale(identifier: "zh-Hans")
        XCTAssertEqual(SessionPreview(text: "Turn failed", type: "error", timestamp: "").displayText(locale: zh), "本轮失败")
        XCTAssertEqual(SessionPreview(text: "Stopped", type: "agent", timestamp: "").displayText(locale: zh), "已停止")
        XCTAssertEqual(SessionPreview(text: "System notice", type: "agent", timestamp: "").displayText(locale: zh), "系统通知")
        XCTAssertEqual(SessionPreview(text: "Stopped", type: "user", timestamp: "").displayText(locale: zh), "Stopped",
                       "the user's own words are never rewritten")
        XCTAssertEqual(SessionPreview(text: "Stopped here", type: "agent", timestamp: "").displayText(locale: zh), "Stopped here")
    }

    func testCardPreviewUsesDisplayText() {
        let card = SessionCardProjection.make(
            session: session(), device: nil,
            preview: SessionPreview(text: "Turn failed", type: "error", timestamp: "2026-09-26T12:00:00.000Z"),
            draft: nil)
        XCTAssertEqual(card.previewText, String(localized: "Turn failed"))
    }
}
#endif
