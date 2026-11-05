#if os(iOS)
import XCTest
import UIKit
@testable import Kraki

/// The chat bubble's long-press menu (TKBubbleCell): what it copies and what
/// it lifts as its preview.
@MainActor
final class BubbleContextMenuTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    private func host(_ view: UIView) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        self.window = window
    }

    private func cell(_ content: TKBubbleContent, width: CGFloat = 390) -> TKBubbleCell {
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: width, height: content.cellHeight(cellWidth: width)))
        cell.configure(content, cellWidth: width)
        cell.layoutIfNeeded()
        return cell
    }

    private func perform(_ action: UIAction) {
        action.perform(NSSelectorFromString("performWithSender:target:"), with: nil, with: nil)
    }

    private func interaction(_ cell: TKBubbleCell) throws -> UIContextMenuInteraction {
        try XCTUnwrap(cell.contentView.interactions.compactMap { $0 as? UIContextMenuInteraction }.first)
    }

    /// The menu the configuration would show (its action provider).
    private func menuActions(_ configuration: UIContextMenuConfiguration) throws -> [UIAction] {
        typealias Provider = @convention(block) ([UIMenuElement]) -> UIMenu?
        let block = try XCTUnwrap(configuration.value(forKey: "actionProvider") as AnyObject?)
        let provider = unsafeBitCast(block, to: Provider.self)
        return provider([])?.children.compactMap { $0 as? UIAction } ?? []
    }

    private func liveContent(_ text: String, session: String) -> TKBubbleContent {
        TKBubbleContent.live(card: MessageStore.SessionCard(text: text), agent: "pi", sessionId: session, steps: 0)
    }

    // MARK: K-149

    /// "Turn failed" with a reason: the reason is in the SwiftUI action slot,
    /// which the cell's long-press menu covers, so the menu copies it.
    func testFailedTurnMenuCopiesItsReason() throws {
        let reason = "TypeError: client.send is not a function"
        let failed = ChatMessage(type: "failed", seq: 0, sessionId: "s", deviceId: nil, timestamp: nil,
                                 payload: ["message": AnyCodable(reason), "failedAt": AnyCodable("2026-01-01T00:00:00Z")])
        let content = TKBubbleContent.live(card: MessageStore.SessionCard(text: "", action: failed), agent: "pi",
                                           sessionId: "s", steps: 0, isFrozen: true)
        let cell = cell(content)
        let copyError = try XCTUnwrap(cell.messageActions().first { $0.title == String(localized: "Copy Error") },
                                      "menu: \(cell.messageActions().map(\.title))")
        UIPasteboard.general.string = ""
        perform(copyError)
        XCTAssertEqual(UIPasteboard.general.string, reason)
    }

    // MARK: K-150

    /// A streaming reply keeps growing under the open menu: Copy copies the
    /// text the user long-pressed, not the text at the moment Copy is tapped.
    func testLiveBubbleCopyTakesTheTextAtLongPress() throws {
        let session = "menu-live-\(UUID().uuidString)"
        let pressed = "The first part of the answer"
        let cell = cell(liveContent(pressed, session: session))
        try host(cell)
        cell.layoutIfNeeded()
        let point = CGPoint(x: cell.bubbleFrameForRegression.midX, y: cell.bubbleFrameForRegression.midY)
        let configuration = try XCTUnwrap(cell.contextMenuInteraction(try interaction(cell),
                                                                      configurationForMenuAtLocation: point))

        cell.configure(liveContent(pressed + " and more words that streamed in while the menu was open",
                                   session: session), cellWidth: 390)

        let copy = try XCTUnwrap(try menuActions(configuration).first { $0.title == String(localized: "Copy") })
        UIPasteboard.general.string = ""
        perform(copy)
        XCTAssertEqual(UIPasteboard.general.string, pressed)
    }

    /// The menu lifts the bubble's on-screen part with rounded corners, not a
    /// square of the whole (taller than the screen) cell.
    func testMenuPreviewIsTheVisiblePartOfTheBubble() throws {
        let long = (1...80).map { "Line \($0) of a long reply." }.joined(separator: "\n\n")
        let message = ChatMessage(type: "agent_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["content": AnyCodable(long)])
        let cell = cell(TKBubbleContent.make(message: message, sessionId: "s", agent: "pi"))
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 100, width: 390, height: 500))
        scroll.contentSize = cell.bounds.size
        scroll.addSubview(cell)
        try host(scroll)
        cell.layoutIfNeeded()
        XCTAssertGreaterThan(cell.bubbleFrameForRegression.height, 500)

        let point = CGPoint(x: cell.bubbleFrameForRegression.midX, y: 200)
        let interaction = try interaction(cell)
        let configuration = try XCTUnwrap(cell.contextMenuInteraction(interaction, configurationForMenuAtLocation: point))
        let delegate: UIContextMenuInteractionDelegate = cell
        let preview = try XCTUnwrap(delegate.contextMenuInteraction?(
            interaction, configuration: configuration,
            highlightPreviewForItemWithIdentifier: configuration.identifier), "no targeted preview")
        let path = try XCTUnwrap(preview.parameters.visiblePath)
        XCTAssertLessThanOrEqual(path.bounds.height, 500.5, "only the on-screen part of the bubble")
        XCTAssertEqual(path.bounds.minX, cell.bubbleFrameForRegression.minX, accuracy: 0.5)
        XCTAssertEqual(path.bounds.width, cell.bubbleFrameForRegression.width, accuracy: 0.5)
        XCTAssertEqual(preview.parameters.backgroundColor, .clear)
    }
}
#endif
