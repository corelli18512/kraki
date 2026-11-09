import AppKit
import Carbon
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Settings › General › Account Usage follows the shortcut recorder: the
/// toggle names the chosen key and a refused key shows why (K-259). Laid
/// out in a window that is never put on screen.
@MainActor
final class MacGeneralPaneUsageHotKeyTests: XCTestCase {
    private static let shortcutKey = "mac.usagePeekShortcut"
    private var savedShortcut: Any?
    private var window: NSWindow?
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        savedShortcut = UserDefaults.standard.object(forKey: Self.shortcutKey)
        XCTAssertFalse(UsagePeekController.shared.hotkey.enabled, "fixture: the test host never enables the hotkey")
        XCTAssertTrue(UsagePeekController.shared.hotkey.update(.initial))
        root = FileManager.default.temporaryDirectory.appendingPathComponent("general-pane-\(UUID().uuidString)")
    }

    override func tearDown() {
        window?.contentView = nil
        window = nil
        UsagePeekController.shared.hotkey.update(.initial)
        if let savedShortcut {
            UserDefaults.standard.set(savedShortcut, forKey: Self.shortcutKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.shortcutKey)
        }
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private func texts(in element: Any) -> [String] {
        var found: [String] = []
        let object = element as AnyObject
        let label: String?? = object.accessibilityLabel?()
        let title: String?? = object.accessibilityTitle?()
        let value: Any?? = object.accessibilityValue?()
        for text in [label ?? nil, title ?? nil, (value ?? nil) as? String] {
            if let text, !text.isEmpty { found.append(text) }
        }
        let children: [Any]?? = object.accessibilityChildren?()
        if let children = children ?? nil {
            for child in children { found += texts(in: child) }
        }
        return found
    }

    private func mountPane() throws -> NSView {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        let host = NSHostingView(rootView: GeneralPane().environment(app).environment(TentacleCLIManager())
            .frame(width: 540, height: 900))
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 540, height: 900),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        self.window = window
        drain(500)
        XCTAssertFalse(window.isVisible)
        return host
    }

    func testToggleNamesTheNewlyChosenKey() throws {
        let pane = try mountPane()
        XCTAssertTrue(texts(in: pane).contains { $0.contains("Hold F6") }, "fixture: \(texts(in: pane))")
        let f7 = UsageShortcut(keyCode: 98, modifiers: 0, keyName: "F7")
        XCTAssertTrue(UsagePeekController.shared.hotkey.update(f7))
        drain(300)
        let shown = texts(in: pane)
        XCTAssertTrue(shown.contains { $0.contains("Hold F7") }, "the toggle follows the recorder: \(shown)")
        XCTAssertFalse(shown.contains { $0.contains("Hold F6") })
    }

    func testRefusedPlainKeyExplainsWhy() throws {
        let pane = try mountPane()
        let plainA = UsageShortcut(keyCode: 0, modifiers: 0, keyName: "A")
        XCTAssertFalse(UsagePeekController.shared.hotkey.update(plainA))
        drain(300)
        XCTAssertTrue(texts(in: pane).contains("Use F1–F20, or a combination with ⌘, ⌃ or ⌥."),
                      "the refusal is shown: \(texts(in: pane))")
    }
}
