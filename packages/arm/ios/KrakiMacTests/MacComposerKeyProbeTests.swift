import XCTest
import AppKit
@testable import Kraki_Dev

/// 2-42 (review group 2, 2026-10-13): Option-Space / Esc / Cmd-V shortcuts.
final class MacComposerKeyProbeTests: XCTestCase {
    private typealias Probe = MacComposerVoiceKeyProbeView
    private let space: UInt16 = 49
    private let escape: UInt16 = 53

    func testOptionSpaceTogglesOncePerPressAndSwallowsRepeats() {
        XCTAssertEqual(Probe.action(keyCode: space, flags: .option, isRepeat: false, voiceActive: false), .toggle)
        XCTAssertEqual(Probe.action(keyCode: space, flags: .option, isRepeat: true, voiceActive: true), .swallow,
                       "holding Option-Space must not stop and restart recording")
    }

    func testCapsLockDoesNotBreakShortcuts() {
        XCTAssertEqual(Probe.action(keyCode: space, flags: [.option, .capsLock], isRepeat: false, voiceActive: false),
                       .toggle)
        XCTAssertEqual(Probe.action(keyCode: escape, flags: .capsLock, isRepeat: false, voiceActive: true), .cancel)
        XCTAssertEqual(NSEvent.ModifierFlags([.command, .capsLock]).shortcutModifiers, .command)
        XCTAssertEqual(NSEvent.ModifierFlags([.command, .function, .numericPad]).shortcutModifiers, .command)
    }

    func testOtherKeysPassThrough() {
        XCTAssertEqual(Probe.action(keyCode: space, flags: [], isRepeat: false, voiceActive: true), .pass)
        XCTAssertEqual(Probe.action(keyCode: space, flags: [.option, .shift], isRepeat: false, voiceActive: false), .pass)
        XCTAssertEqual(Probe.action(keyCode: escape, flags: [], isRepeat: false, voiceActive: false), .pass)
    }

    /// Finding 11 (mac input audit): the shortcuts stay window-wide, except
    /// where focus needs the keys: another text input, or IME marked text.
    func testFocusThatOwnsTheKeys() {
        XCTAssertFalse(Probe.focusOwnsKeys(nil), "nothing focused")
        XCTAssertFalse(Probe.focusOwnsKeys(NSView()), "a list or button")
        XCTAssertFalse(Probe.focusOwnsKeys(MacComposerTextView(usingTextLayoutManager: false)), "the composer")

        let fieldEditor = NSTextView()
        fieldEditor.isFieldEditor = true
        XCTAssertTrue(Probe.focusOwnsKeys(fieldEditor), "an NSTextField being edited (sidebar Search, rename)")
        XCTAssertTrue(Probe.focusOwnsKeys(NSTextView()), "another editable text view")
        let readOnly = NSTextView()
        readOnly.isEditable = false
        XCTAssertFalse(Probe.focusOwnsKeys(readOnly), "selectable message text takes no typing")

        let composing = MacComposerTextView(usingTextLayoutManager: false)
        composing.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0),
                                replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(composing.hasMarkedText())
        XCTAssertTrue(Probe.focusOwnsKeys(composing), "an IME composition in the composer")
    }
}
