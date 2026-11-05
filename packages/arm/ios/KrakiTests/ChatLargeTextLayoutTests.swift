#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// Chat chrome at the largest accessibility text size (K-312).
@MainActor
final class ChatLargeTextLayoutTests: XCTestCase {
    private func stepsChip(_ category: UIContentSizeCategory) throws -> CGRect {
        let message = ChatMessage(type: "system_message", seq: 9, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["kind": AnyCodable("no_reply"), "steps": AnyCodable(3)])
        let content = TKBubbleContent.make(message: message, sessionId: "s", agent: "pi")
        XCTAssertTrue(content.isStepsOnly)
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 100, width: 390, height: content.cellHeight(cellWidth: 390)))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.traitOverrides.preferredContentSizeCategory = category
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(cell)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        cell.configure(content, cellWidth: 390)
        cell.layoutIfNeeded()
        let chip = try XCTUnwrap(cell.contentView.subviews.compactMap { $0 as? UIButton }
            .first { $0.accessibilityLabel == String(localized: "Show steps") })
        chip.setNeedsLayout()
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
        return chip.frame
    }

    /// The Steps "···" chip straddles the bubble's top edge. It keeps its size
    /// at AX-XXXL; grown with Dynamic Type it covered the message above.
    func testStepsChipKeepsItsSizeAtTheLargestText() throws {
        let regular = try stepsChip(.large)
        let largest = try stepsChip(.accessibilityExtraExtraExtraLarge)
        XCTAssertEqual(largest.height, regular.height, accuracy: 0.5)
        XCTAssertEqual(largest.width, regular.width, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(largest.minY, -TKMetrics.outerV, "the chip stays within the gap above its row")
    }

    /// The subagent card's status icon frame grows with the text, so a large
    /// glyph does not spill over the subagent's name.
    func testSubagentStatusIconGrowsWithTheText() {
        func size(_ dynamicType: DynamicTypeSize) -> CGSize {
            let host = UIHostingController(rootView: SubagentStatusIcon(status: .completed)
                .environment(\.dynamicTypeSize, dynamicType))
            return host.sizeThatFits(in: CGSize(width: 400, height: 400))
        }
        let regular = size(.large)
        let largest = size(.accessibility5)
        XCTAssertEqual(regular.width, 18, accuracy: 0.5)
        XCTAssertGreaterThan(largest.width, regular.width * 1.5)
        XCTAssertGreaterThan(largest.height, regular.height * 1.5)
    }
}
#endif
