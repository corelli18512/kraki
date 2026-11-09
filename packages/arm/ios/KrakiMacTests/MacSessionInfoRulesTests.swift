import XCTest
@testable import Kraki_Dev

/// Session Info on the Mac: a typed title survives Done/Esc (K-045), and a
/// model change keeps the chosen Thinking level when it can (K-264).
final class MacSessionInfoRulesTests: XCTestCase {
    func testDoneOrEscWhileEditingSavesTheTypedTitle() {
        XCTAssertEqual(MacSessionInfoRules.titleToSaveOnClose(editing: true, draft: "  Release notes ", original: "Old"),
                       "Release notes")
        XCTAssertEqual(MacSessionInfoRules.titleToSaveOnClose(editing: true, draft: "", original: "Old"), "",
                       "clearing the title is a change too")
    }

    func testClosingWithoutAChangeSavesNothing() {
        XCTAssertNil(MacSessionInfoRules.titleToSaveOnClose(editing: false, draft: "New", original: "Old"),
                     "not editing: the title was already saved")
        XCTAssertNil(MacSessionInfoRules.titleToSaveOnClose(editing: true, draft: "Auto title ", original: "Auto title"),
                     "an untouched auto title is not turned into a fixed one")
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
}
