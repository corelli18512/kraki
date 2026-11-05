#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// K-188: at accessibility text sizes the session card truncated its time
/// ("yesterd…") and the login screen ignored Dynamic Type (fixed point sizes).
@MainActor
final class DynamicTypeLayoutTests: XCTestCase {
    private var tree: AccessibilityTreeHost?

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    override func tearDown() {
        tree?.tearDown()
        tree = nil
        super.tearDown()
    }

    func testCardTimeIsNeverTruncatedAtAccessibilitySizes() throws {
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let app = AppState.makeUnitTestHost()
        let yesterday = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: -1, to: Date()))
        app.sessionStore.upsertSession(SessionInfo(
            id: "ax-card", deviceId: "dev", deviceName: "mac", agent: "pi",
            model: "gpt-5", reasoningEffort: nil, title: "New Session",
            state: .idle, mode: .safe, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: yesterday, pinned: false))
        // iPhone list cell content width (393 pt screen less the cell insets).
        for (size, category) in [(DynamicTypeSize.accessibility1, UIContentSizeCategory.accessibilityMedium),
                                 (.accessibility5, .accessibilityExtraExtraExtraLarge)] {
            _ = try tree.show(
                SessionCardView(sessionId: "ax-card")
                    .frame(width: 353)
                    .environment(\.dynamicTypeSize, size)
                    .environment(app)
            )
            let time = try XCTUnwrap(tree.elements(label: "yesterday").first, "\(size)").accessibilityFrame
            let font = UIFont.preferredFont(forTextStyle: .caption2,
                                            compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
            let natural = ceil(("yesterday" as NSString).size(withAttributes: [.font: font]).width)
            XCTAssertGreaterThanOrEqual(time.width, natural - 1, "time truncated at \(size): \(time) < \(natural)")
        }
    }

    func testLoginTextFollowsDynamicType() throws {
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        func titleHeight(_ size: DynamicTypeSize) throws -> CGFloat {
            let app = AppState.makeUnitTestHost()
            _ = try tree.show(LoginView().environment(\.dynamicTypeSize, size).environment(app))
            tree.drain(2.2) // the title fades in after 1 s
            return try XCTUnwrap(tree.elements(label: "Welcome to Kraki").first, "title at \(size)").accessibilityFrame.height
        }
        let regular = try titleHeight(.large)
        let large = try titleHeight(.accessibility3)
        XCTAssertGreaterThan(large, regular * 1.5, "regular \(regular), AX3 \(large)")
    }
}
#endif
