import AppKit
import Carbon
import SwiftUI
import XCTest
@testable import Kraki_Dev

final class UsagePeekTests: XCTestCase {
    func testHoldShowsCompactHoverExpandsReleaseHides() {
        var s = UsagePeekState()
        XCTAssertEqual(s.presentation, .hidden)
        s.press(); XCTAssertEqual(s.presentation, .compact)
        s.hover(true); XCTAssertEqual(s.presentation, .detailed)
        s.hover(false); XCTAssertEqual(s.presentation, .compact)
        s.hover(true); s.release()
        XCTAssertEqual(s.presentation, .hidden)
        s.hover(true); XCTAssertEqual(s.presentation, .hidden, "a late hover can't reopen a released peek")
    }

    func testMenuOpenedPanelIsDetailedAndSurvivesKeyRelease() {
        var s = UsagePeekState()
        s.click(); XCTAssertEqual(s.presentation, .detailed)
        s.press(); s.hover(false); s.release()
        XCTAssertEqual(s.presentation, .detailed)
        s.click(); XCTAssertEqual(s.presentation, .hidden)
    }

    func testShortcutsMustNotHijackTyping() {
        XCTAssertEqual(UsageShortcut.initial.display, "F6")
        XCTAssertTrue(UsageShortcut.initial.isSafeToRegister)
        XCTAssertFalse(UsageShortcut(keyCode: 0, modifiers: 0, keyName: "A").isSafeToRegister)
        XCTAssertFalse(UsageShortcut(keyCode: 0, modifiers: UInt32(shiftKey), keyName: "A").isSafeToRegister)
        XCTAssertFalse(UsageShortcut(keyCode: 53, modifiers: UInt32(cmdKey), keyName: "Esc").isSafeToRegister)
        let combo = UsageShortcut(keyCode: 32, modifiers: UInt32(controlKey | optionKey), keyName: "U")
        XCTAssertTrue(combo.isSafeToRegister)
        XCTAssertEqual(combo.display, "⌃⌥U")
    }

    func testPanelHeightFollowsAccountCount() {
        XCTAssertEqual(UsagePeekLayout.rows(3), 1)
        XCTAssertEqual(UsagePeekLayout.rows(4), 2)
        XCTAssertLessThan(UsagePeekLayout.compactHeight(3), UsagePeekLayout.compactHeight(4))
        XCTAssertEqual(UsagePeekLayout.compactHeight(6), UsagePeekLayout.compactHeight(9), "compact shows at most six")
        XCTAssertLessThan(UsagePeekLayout.detailHeight(3), UsagePeekLayout.detailHeight(4))
    }
}

/// Renders the panel with real-shaped data to PNGs for visual review.
/// Writes to KRAKI_USAGE_RENDER_DIR when set; otherwise only checks rendering works.
@MainActor
final class UsagePeekRenderTests: XCTestCase {
    private func device(_ id: String, _ name: String, kind: DeviceKind = .desktop) -> DeviceSummary {
        DeviceSummary(id: id, name: name, role: .tentacle, kind: kind, publicKey: nil, encryptionKey: nil,
                      online: true, lastSeen: nil, createdAt: nil)
    }
    private func window(_ kind: String, _ remaining: Double, hours: Double) -> AccountUsageWindow {
        AccountUsageWindow(id: kind == "five_hour" ? "five_hour" : "seven_day", kind: kind, remainingPercent: remaining,
                           resetsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(hours * 3600)),
                           durationSeconds: kind == "five_hour" ? 18000 : 604800)
    }
    private func account(_ key: String, _ provider: String, _ label: String, _ plan: String, _ windows: [AccountUsageWindow]) -> AccountUsage {
        AccountUsage(accountKey: key, provider: provider, label: label, plan: plan, windows: windows,
                     fetchedAt: ISO8601DateFormatter().string(from: Date()))
    }

    func testRenderPanels() throws {
        let mac = device("mac", "MacBook Pro")
        let server = device("srv", "build-server", kind: .server)
        let mac2 = device("mac2", "Mac mini")
        let claudeMain = account("claude:1", "claude", "co•••ai@gmail.com", "default_claude_max_20x", [window("five_hour", 80, hours: 2.3), window("weekly", 12, hours: 52)])
        // The current Session is a Pi session on the server spending the shared Max 20× account.
        let accounts = [
            MergedAccountUsage(account: claudeMain, devices: [server, mac, mac2]),
            MergedAccountUsage(account: account("claude:2", "claude", "wo•••rk@studio.dev", "default_claude_max_5x", [window("five_hour", 46, hours: 0.6), window("weekly", 71, hours: 98)]), devices: [server]),
            MergedAccountUsage(account: account("codex:1", "codex", "co•••12@outlook.com", "prolite", [window("weekly", 0, hours: 141)]), devices: [mac, mac2]),
            MergedAccountUsage(account: account("codex:2", "codex", "co•••ai@gmail.com", "prolite", [window("weekly", 64, hours: 134)]), devices: [mac]),
        ]
        let dir = ProcessInfo.processInfo.environment["KRAKI_USAGE_RENDER_DIR"]
        for scheme in [ColorScheme.light, .dark] {
            for (name, view, size) in [
                ("compact", AnyView(UsagePeekCompact(accounts: accounts, currentKey: "claude:1", ns: Namespace().wrappedValue, entering: false)),
                 CGSize(width: UsagePeekLayout.compactWidth, height: UsagePeekLayout.compactHeight(accounts.count))),
                ("detail", AnyView(UsagePeekDetail(accounts: accounts, currentKey: "claude:1", ns: Namespace().wrappedValue, entering: false)),
                 CGSize(width: UsagePeekLayout.detailWidth, height: UsagePeekLayout.detailHeight(accounts.count))),
            ] {
                let content = view
                    .frame(width: size.width, height: size.height)
                    .background(scheme == .dark ? Color(white: 0.16) : Color(white: 0.96))
                    .environment(\.colorScheme, scheme)
                let host = NSHostingView(rootView: content)
                host.frame = NSRect(origin: .zero, size: size)
                let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: size.width, height: size.height),
                                      styleMask: .borderless, backing: .buffered, defer: false)
                window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
                window.contentView = host
                window.orderBack(nil)
                RunLoop.main.run(until: Date().addingTimeInterval(0.4))
                host.layoutSubtreeIfNeeded()
                let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: rep)
                window.orderOut(nil)
                XCTAssertEqual(rep.size.width, size.width, accuracy: 1)
                if let dir, let png = rep.representation(using: .png, properties: [:]) {
                    try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("usage-\(name)-\(scheme == .dark ? "dark" : "light").png"))
                }
            }
        }
    }
}
