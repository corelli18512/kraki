#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// K-167: at accessibility text sizes the stacked Approve / Deny buttons
/// hugged their labels instead of spanning the bubble, and wrapped question
/// choices overflowed their capsule outline.
@MainActor
final class BubbleActionSlotAccessibilityTests: XCTestCase {
    private var tree: AccessibilityTreeHost?

    override func tearDown() {
        tree?.tearDown()
        tree = nil
        super.tearDown()
    }

    private func permission() -> ChatMessage {
        ChatMessage(type: "permission", seq: 1, sessionId: "ax", deviceId: "demo", timestamp: nil, payload: [
            "permissionId": AnyCodable("ax-permission"), "toolName": AnyCodable("shell"),
            "description": AnyCodable("Run a command"),
            "args": AnyCodable(["command": AnyCodable("ls -la")]),
        ])
    }

    func testStackedPermissionButtonsSpanTheBubbleAtAccessibilitySizes() throws {
        try requireForegroundUITests()
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let width: CGFloat = 330
        _ = try tree.show(
            BubbleActionSlot(action: permission(), sessionMode: .safe)
                .frame(width: width)
                .fixedSize(horizontal: false, vertical: true)
                .environment(\.dynamicTypeSize, .accessibility5)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        )
        let approve = try XCTUnwrap(tree.elements(label: "Approve permission").first).accessibilityFrame
        let deny = try XCTUnwrap(tree.elements(label: "Deny permission").first).accessibilityFrame
        XCTAssertGreaterThan(deny.minY, approve.minY, "stacked at AX5")
        XCTAssertEqual(approve.width, width, accuracy: 1)
        XCTAssertEqual(deny.width, width, accuracy: 1)
    }

    func testChoiceOutlineIsACapsuleOnlyWhileItIsOneLine() {
        let shape = BubbleChoiceShape()
        let oneLine = shape.path(in: CGRect(x: 0, y: 0, width: 200, height: 32))
        XCTAssertEqual(oneLine.boundingRect, CGRect(x: 0, y: 0, width: 200, height: 32))
        XCTAssertFalse(oneLine.contains(CGPoint(x: 3, y: 3)), "fully round ends, like Capsule()")
        XCTAssertTrue(oneLine.contains(CGPoint(x: 16, y: 16)))
        // A wrapped choice: a capsule would be 120 pt round and cut the
        // corners where the first / last letters sit.
        let wrapped = shape.path(in: CGRect(x: 0, y: 0, width: 260, height: 120))
        XCTAssertTrue(wrapped.contains(CGPoint(x: 14, y: 14)))
        XCTAssertTrue(wrapped.contains(CGPoint(x: 246, y: 106)))
        XCTAssertFalse(Capsule().path(in: CGRect(x: 0, y: 0, width: 260, height: 120)).contains(CGPoint(x: 14, y: 14)))
    }
}
#endif
