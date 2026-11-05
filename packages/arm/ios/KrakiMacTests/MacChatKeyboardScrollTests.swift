#if os(macOS) && DEBUG
import AppKit
import XCTest
@testable import Kraki_Dev

/// K-121: Page Up/Down worked once, then the recycled bubble took keyboard
/// focus with it; ↑/↓ and Home/End never scrolled. Window never shown.
@MainActor
final class MacChatKeyboardScrollTests: XCTestCase {
    private var window: NSWindow?

    override func tearDown() {
        window?.contentView = nil
        window = nil
        super.tearDown()
    }

    private final class FocusableText: NSView {
        override var acceptsFirstResponder: Bool { true }
    }

    private func chat() -> MacChatScrollView {
        let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 600, height: 400),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        self.window = window
        let chat = MacChatScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        window.contentView = chat
        return chat
    }

    func testRecyclingTheFocusedBubbleKeepsKeyboardFocusInTheChat() throws {
        let chat = chat()
        let document = chat.chatDocumentView
        let cell = document.dequeueCell()
        let text = FocusableText(frame: NSRect(x: 0, y: 0, width: 100, height: 20))
        cell.isHidden = false
        cell.addSubview(text)
        let window = try XCTUnwrap(self.window)
        XCTAssertTrue(window.makeFirstResponder(text))

        document.recycle(cell)

        XCTAssertTrue(window.firstResponder === chat.keyboardFocusView,
                      "focus went to \(String(describing: window.firstResponder))")
        XCTAssertFalse(chat.keyboardFocusView.canBecomeKeyView, "no extra Tab stop")
        XCTAssertNil(chat.keyboardFocusView.hitTest(.zero), "never takes a click")

        // Keys typed there reach the chat's scrolling.
        chat.chatDocumentView.frame = NSRect(x: 0, y: 0, width: 600, height: 5_000)
        chat.contentView.bounds.origin.y = 2_000
        window.sendEvent(try key(121, NSPageDownFunctionKey))
        XCTAssertGreaterThan(chat.contentView.bounds.minY, 2_000, "Page Down after the bubble was recycled")
    }

    func testScrollKeysMapToPagesLinesAndEnds() {
        func action(_ key: UInt16, _ flags: NSEvent.ModifierFlags = []) -> MacChatKeyboardScroll? {
            MacChatKeyboardScroll.action(keyCode: key, modifiers: flags, page: 300, line: 40)
        }
        XCTAssertEqual(action(116), .by(-300), "Page Up")
        XCTAssertEqual(action(121, [.function]), .by(300), "Page Down")
        XCTAssertEqual(action(126, [.function, .numericPad]), .by(-40), "↑")
        XCTAssertEqual(action(125), .by(40), "↓")
        XCTAssertEqual(action(115), .top, "Home")
        XCTAssertEqual(action(119), .bottom, "End")
        XCTAssertNil(action(126, [.command]), "⌘↑ is not a chat scroll")
        XCTAssertNil(action(125, [.option]))
        XCTAssertNil(action(0), "a letter")
    }

    func testPageAndArrowKeysMoveTheChat() throws {
        let chat = chat()
        chat.chatDocumentView.frame = NSRect(x: 0, y: 0, width: 600, height: 5_000)
        chat.contentView.bounds.origin.y = 2_000
        let before = chat.contentView.bounds.minY
        chat.keyDown(with: try key(116, NSPageUpFunctionKey))
        let afterPageUp = chat.contentView.bounds.minY
        XCTAssertLessThan(afterPageUp, before - 200, "Page Up moves about a page up")
        chat.keyDown(with: try key(125, NSDownArrowFunctionKey))
        XCTAssertGreaterThan(chat.contentView.bounds.minY, afterPageUp, "↓ scrolls")
    }

    private func key(_ code: UInt16, _ function: Int) throws -> NSEvent {
        let character = String(try XCTUnwrap(UnicodeScalar(function)))
        return try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.function],
                                              timestamp: 0, windowNumber: window?.windowNumber ?? 0, context: nil,
                                              characters: character, charactersIgnoringModifiers: character,
                                              isARepeat: false, keyCode: code))
    }
}
#endif
