#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// The composer editor sends text exactly as typed. The window is never
/// ordered on screen: only the representable's editor is built.
@MainActor
final class MacComposerPlainTextTests: XCTestCase {
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }

    /// K-354: with macOS smart quotes on, `"x"` reached the agent as “x”.
    func testComposerEditorDoesNotSubstituteQuotesOrDashes() throws {
        var text = ""
        var focused = false
        var hasText = false
        var composing: String?
        let input = MacComposerScrollableTextInput(
            text: Binding(get: { text }, set: { text = $0 }),
            focused: Binding(get: { focused }, set: { focused = $0 }),
            nativeEditorHasText: Binding(get: { hasText }, set: { hasText = $0 }),
            nativeComposingText: Binding(get: { composing }, set: { composing = $0 }),
            enabled: true, focusRequest: 0,
            onRequestFocus: {}, onSubmit: {}, onSelection: { _ in }, onTakeOver: {})
            .frame(width: 300, height: 60)
        let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 300, height: 60),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        defer { window.contentView = nil }
        let host = NSHostingView(rootView: input)
        host.frame = NSRect(x: 0, y: 0, width: 300, height: 60)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        let editor = try XCTUnwrap(views(host).compactMap { $0 as? MacComposerTextView }.first)
        XCTAssertFalse(editor.isAutomaticQuoteSubstitutionEnabled)
        XCTAssertFalse(editor.isAutomaticDashSubstitutionEnabled)
        XCTAssertFalse(editor.isRichText)
        XCTAssertFalse(editor.importsGraphics)
    }
}
#endif
