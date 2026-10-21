#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Plain typing must not rewrite the editor's text attributes. Every such
/// rewrite refreshes AppKit's input session, which re-showed the system
/// input-source / Caps Lock indicator under the caret every character or two.
@MainActor
final class MacComposerTypingAttributesTests: XCTestCase {
    private final class KeyableWindow: NSWindow { override var canBecomeKey: Bool { true } }

    func testTypingDoesNotRestyleTheText() throws {
        try requireForegroundUITests()
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        let window = KeyableWindow(contentRect: NSRect(x: -6000, y: -6000, width: 640, height: 190), styleMask: [.borderless],
                                   backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: VStack { Spacer(); MacChatComposer(sessionId: "voice-a") }.environment(app))
        window.orderFrontRegardless(); window.makeKey()
        defer { window.orderOut(nil); window.contentView = nil; app.iosVoiceComposer.discard(); app.voiceInputController.forgetLease() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        func all(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap(all) }
        let editor = try XCTUnwrap(all(try XCTUnwrap(window.contentView)).compactMap { $0 as? NSTextView }.first(where: \.isEditable))
        window.makeFirstResponder(editor)
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        var attributeOnlyEdits = 0
        let observer = NotificationCenter.default.addObserver(
            forName: NSTextStorage.didProcessEditingNotification, object: editor.textStorage, queue: nil
        ) { note in
            guard let storage = note.object as? NSTextStorage else { return }
            if storage.editedMask.contains(.editedAttributes), !storage.editedMask.contains(.editedCharacters) { attributeOnlyEdits += 1 }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        for ch in "typing 中文 text" {
            editor.insertText(String(ch), replacementRange: editor.selectedRange())
            RunLoop.main.run(until: Date().addingTimeInterval(0.08))
        }
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], "typing 中文 text")
        XCTAssertEqual(attributeOnlyEdits, 0, "typing must not rewrite text attributes")
        XCTAssertTrue(window.firstResponder === editor, "the editor keeps focus")
    }
}
#endif
