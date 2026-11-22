import XCTest
@testable import Kraki_Dev

/// Session Info on the Mac: a typed title survives Done/Esc (K-045), a
/// model change keeps the chosen Thinking level when it can (K-264), and the
/// total cost shows a plain "$" in every region (K-305).
final class MacSessionInfoRulesTests: XCTestCase {
    private func session(title: String?, autoTitle: String?) -> SessionInfo {
        SessionInfo(id: "s", deviceId: "d", deviceName: "D", agent: "pi", title: title, autoTitle: autoTitle,
                    state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
                    createdAt: Date(), pinned: false)
    }

    func testDoneOrEscWhileEditingSavesTheTypedTitle() {
        let manual = session(title: "Old", autoTitle: nil)
        XCTAssertEqual(MacSessionInfoRules.titleToSaveOnClose(editing: true, draft: "  Release notes ", session: manual),
                       "Release notes")
        XCTAssertEqual(MacSessionInfoRules.titleToSaveOnClose(editing: true, draft: "", session: manual), "",
                       "clearing a set title is a change too")
    }

    func testClosingWithoutAChangeSavesNothing() {
        let manual = session(title: "Old", autoTitle: nil)
        let auto = session(title: nil, autoTitle: "Auto title")
        XCTAssertNil(MacSessionInfoRules.titleToSaveOnClose(editing: false, draft: "New", session: manual),
                     "not editing: the title was already saved")
        XCTAssertNil(MacSessionInfoRules.titleToSaveOnClose(editing: true, draft: "Auto title ", session: auto),
                     "an untouched auto title is not turned into a fixed one")
        XCTAssertNil(MacSessionInfoRules.titleToSaveOnClose(editing: true, draft: "", session: auto),
                     "clearing a title that was never set is a no-op (K-043)")
    }

    private let details = [
        ModelDetail(id: "a", name: "A", supportsReasoningEffort: true,
                    supportedReasoningEfforts: [.low, .medium, .high], defaultReasoningEffort: .high),
        ModelDetail(id: "b", name: "B", supportsReasoningEffort: true,
                    supportedReasoningEfforts: [.low, .medium, .high, .xhigh], defaultReasoningEffort: .high),
        ModelDetail(id: "c", name: "C", supportsReasoningEffort: true,
                    supportedReasoningEfforts: [.high, .max], defaultReasoningEffort: .high),
        ModelDetail(id: "plain", name: "Plain", supportsReasoningEffort: false),
    ]

    func testModelChangeKeepsASupportedThinkingLevel() {
        XCTAssertEqual(MacSessionInfoRules.effortAfterModelChange(to: "b", in: details, current: .low), .low)
        XCTAssertEqual(MacSessionInfoRules.effortAfterModelChange(to: "b", in: details, current: .medium), .medium)
    }

    func testModelChangeFallsBackToTheModelDefault() {
        XCTAssertEqual(MacSessionInfoRules.effortAfterModelChange(to: "c", in: details, current: .low), .high,
                       "Low is not offered by C")
        XCTAssertEqual(MacSessionInfoRules.effortAfterModelChange(to: "a", in: details, current: nil), .high)
        XCTAssertNil(MacSessionInfoRules.effortAfterModelChange(to: "plain", in: details, current: .low))
    }

    /// K-305 owner choice: the cost row (MacChatFormat.cost → UsageNumberFormat)
    /// shows "$", not "US$" / "USD", with the region's grouping, separators and
    /// symbol side.
    func testTotalCostUsesPlainDollarSignInEveryRegion() {
        func cost(_ value: Double, _ id: String) -> String {
            UsageNumberFormat.cost(value, locale: Locale(identifier: id))
        }
        XCTAssertEqual(cost(1234.568, "en_US"), "$1,234.568")
        XCTAssertEqual(cost(1234.568, "en_GB"), "$1,234.568")
        XCTAssertEqual(cost(1234.568, "zh_Hans_CN"), "$1,234.568")
        XCTAssertEqual(cost(1234.568, "de_DE"), "1.234,568\u{00A0}$")
        XCTAssertEqual(cost(0.042, "en_GB"), "$0.042")
        XCTAssertEqual(cost(0.001, "zh_Hans_CN"), "$0.0010")
        for id in ["en_US", "en_GB", "zh_Hans_CN", "de_DE"] {
            XCTAssertFalse(cost(1234.568, id).contains("US"), id)
        }
    }
}
