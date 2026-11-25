#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// K-342: at accessibility text sizes the agent chips shared one plain HStack
/// row, broke names mid-word and grew to ~188 pt tall.
@MainActor
final class NewSessionAgentChipStripTests: XCTestCase {
    private var tree: AccessibilityTreeHost?

    override func tearDown() {
        tree?.tearDown()
        tree = nil
        super.tearDown()
    }

    func testChipsStayOneLineInOneRowAtAccessibilitySizes() throws {
        try requireForegroundUITests()
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let agents = ["claude", "codex", "copilot", "pi"]
        _ = try tree.show(
            NewSessionAgentChipStrip(agentIds: agents, selectedAgentId: "codex", onSelect: { _ in })
                .frame(width: 320)
                .environment(\.dynamicTypeSize, .accessibility5)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        )
        let labels = agents.map { AgentInfo.from($0).label }
        let chips = try labels.map { label in
            try XCTUnwrap(tree.elements(label: label).first, "chip \(label)").accessibilityFrame
        }
        let oneLine = UIFont.preferredFont(forTextStyle: .subheadline,
                                           compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)).lineHeight
        for (label, chip) in zip(labels, chips) {
            XCTAssertLessThanOrEqual(chip.height, oneLine + 14 + 4, "\(label) wrapped: \(chip)")
            XCTAssertEqual(chip.minY, chips[0].minY, accuracy: 1, "\(label) left the row")
        }
    }
}
#endif
