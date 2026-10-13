import AppKit
import XCTest
@testable import Kraki_Dev

/// Review group 1, 1-09: programmatic draft replacement must not leave typing
/// undo records that point into the previous text.
@MainActor
final class MacComposerUndoTests: XCTestCase {
    func testReplacingTheDraftDropsTypingUndoRecords() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let textView = MacComposerTextView(frame: window.contentView!.bounds)
        textView.allowsUndo = true
        window.contentView?.addSubview(textView)
        window.makeFirstResponder(textView)
        textView.insertText("please review the deploy script", replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertEqual(textView.undoManager?.canUndo, true)

        textView.string = "voice text"
        MacComposerScrollableTextInput.dropUndoHistory(of: textView)

        XCTAssertEqual(textView.undoManager?.canUndo, false)
        XCTAssertEqual(textView.string, "voice text")
        window.close()
    }
}
