#if os(macOS) && DEBUG
import AppKit
import XCTest
@testable import Kraki_Dev

/// K-253: Zoom In was bound to the layout-mapped "=" (⌘* on a German
/// keyboard), so ⌘+ did nothing there. It is now ⌘+ as typed, plus ⌘=.
@MainActor
final class MacZoomShortcutTests: XCTestCase {
    private func key(_ characters: String, _ flags: NSEvent.ModifierFlags, code: UInt16) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                       windowNumber: 0, context: nil, characters: characters,
                                       charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
    }

    func testCommandEqualsIsZoomIn() throws {
        XCTAssertTrue(MacZoomShortcut.isZoomInAlias(try key("=", [.command], code: 24)))
        XCTAssertTrue(MacZoomShortcut.isZoomInAlias(try key("=", [.command, .capsLock], code: 24)))
    }

    func testOtherKeysAreLeftAlone() throws {
        XCTAssertFalse(MacZoomShortcut.isZoomInAlias(try key("=", [], code: 24)), "typing =")
        XCTAssertFalse(MacZoomShortcut.isZoomInAlias(try key("=", [.command, .shift], code: 29)), "German ⇧⌘0")
        XCTAssertFalse(MacZoomShortcut.isZoomInAlias(try key("=", [.command, .option], code: 24)))
        XCTAssertFalse(MacZoomShortcut.isZoomInAlias(try key("-", [.command], code: 27)), "Zoom Out")
    }

    /// The menu item's ⌘+ matches a "+" typed with ⌘ (German + key, or ⇧= on US).
    func testPlusKeyEquivalentMatchesTypedPlus() throws {
        let menu = NSMenu()
        let item = NSMenuItem(title: "Zoom In", action: #selector(Target.fire), keyEquivalent: "+")
        let target = Target()
        item.target = target
        item.keyEquivalentModifierMask = .command
        menu.addItem(item)
        XCTAssertTrue(menu.performKeyEquivalent(with: try key("+", [.command], code: 30)), "German ⌘+")
        XCTAssertTrue(menu.performKeyEquivalent(with: try key("+", [.command, .shift], code: 24)), "US ⇧⌘=")
        XCTAssertEqual(target.count, 2)
    }

    private final class Target: NSObject {
        var count = 0
        @objc func fire() { count += 1 }
    }
}
#endif
