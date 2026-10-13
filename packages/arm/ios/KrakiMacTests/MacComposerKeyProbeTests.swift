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
}
