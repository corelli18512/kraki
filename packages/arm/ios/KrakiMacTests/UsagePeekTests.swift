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

    func testGlobalShortcutIsOffUntilTurnedOnAndRemembersItsKey() throws {
        let suite = "usage-peek-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let hotkey = UsagePeekHotKey(defaults: defaults)
        XCTAssertFalse(hotkey.enabled, "an upgrade must not take F6 by itself")
        let f7 = UsageShortcut(keyCode: 98, modifiers: 0, keyName: "F7")
        XCTAssertTrue(hotkey.update(f7), "choosing a key while off just remembers it")
        XCTAssertEqual(UsagePeekHotKey(defaults: defaults).shortcut, f7)
        hotkey.setEnabled(true)
        XCTAssertTrue(UsagePeekHotKey(defaults: defaults).enabled)
        hotkey.setEnabled(false)
        XCTAssertFalse(UsagePeekHotKey(defaults: defaults).enabled)
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

    func testSmartLayoutBalancesRowsAndNarrowsThePanel() {
        func rows(_ rings: [Int], _ m: UsagePeekLayout.Mode) -> [[Int]] { UsagePeekLayout.plan(rings: rings, m).rows }
        // Two 2-ring + two 1-ring accounts: 2 + 2, not 3 + 1.
        XCTAssertEqual(rows([2, 2, 1, 1], .compact), [[0, 1], [2, 3]])
        XCTAssertEqual(rows([2, 2, 1, 1], .detail), [[0, 1], [2, 3]])
        // Mostly weekly-only accounts fit three to a row.
        XCTAssertEqual(rows([1, 1, 1], .compact), [[0, 1, 2]])
        // Five cards split 3 + 2, never 4 + 1.
        let five = rows([1, 1, 1, 1, 1], .compact)
        XCTAssertEqual(five.map(\.count).sorted(), [2, 3])
        // Compact shows at most six.
        XCTAssertEqual(rows(Array(repeating: 1, count: 9), .compact).flatMap { $0 }.count, 6)
        for rings in [[2], [1, 2], [2, 2, 1, 1], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2]] {
            for m in [UsagePeekLayout.Mode.compact, .detail] {
                let plan = UsagePeekLayout.plan(rings: rings, m)
                let inner = plan.size.width - UsagePeekLayout.padding(m) * 2
                XCTAssertLessThanOrEqual(plan.size.width, UsagePeekLayout.maxWidth(m) + 0.5)
                for row in plan.rows {
                    // Every row fills the same width and no card is below its minimum.
                    let used = row.map { plan.widths[$0] }.reduce(0, +) + UsagePeekLayout.gap(m) * CGFloat(row.count - 1)
                    XCTAssertEqual(used, inner, accuracy: CGFloat(row.count))
                    for i in row { XCTAssertGreaterThanOrEqual(plan.widths[i], UsagePeekLayout.minWidth(rings: rings[i], m) - 1) }
                }
            }
        }
        // One account doesn't get a half-empty 460-point panel.
        XCTAssertLessThan(UsagePeekLayout.plan(rings: [1], .compact).size.width, 200)
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
        var extraGPT: [MergedAccountUsage] = []
        for n in 3...6 {
            let five: AccountUsageWindow = window("five_hour", Double(90 - n * 9), hours: 1.5)
            let weekly: AccountUsageWindow = window("weekly", Double(70 - n * 6), hours: 90)
            let acc: AccountUsage = account("codex:x\(n)", "codex", "te•••m\(n)@corp.dev", "pro", [five, weekly])
            extraGPT.append(MergedAccountUsage(account: acc, devices: [mac]))
        }
        let scenarios: [(String, [MergedAccountUsage])] = [
            ("n1", Array(accounts.prefix(1))),
            ("n2", [accounts[0], accounts[2]]),
            ("n3", Array(accounts.prefix(3))),
            ("n4", accounts),
            ("n5", accounts + [extraGPT[0]]),
            ("n6", accounts + Array(extraGPT.prefix(2))),
        ]
        for (tag, list) in scenarios {
            let schemes: [ColorScheme] = tag == "n4" ? [.light, .dark] : [.dark]
            for scheme in schemes {
                let compactPlan = UsagePeekLayout.plan(rings: list.map(\.ringCount), .compact)
                let detailPlan = UsagePeekLayout.plan(rings: list.map(\.ringCount), .detail)
                let compactView: AnyView = AnyView(UsagePeekCompact(accounts: list, width: compactPlan.size.width, currentKey: "claude:1", ns: Namespace().wrappedValue, entering: false))
                let detailView: AnyView = AnyView(UsagePeekDetail(accounts: list, width: detailPlan.size.width, currentKey: "claude:1", ns: Namespace().wrappedValue, entering: false))
                let items: [(String, AnyView, CGSize)] = [("compact", compactView, compactPlan.size), ("detail", detailView, detailPlan.size)]
                for (name, view, size) in items {
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
                    RunLoop.main.run(until: Date().addingTimeInterval(1.2))
                    host.layoutSubtreeIfNeeded()
                    let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: rep)
                    window.orderOut(nil)
                    XCTAssertEqual(rep.size.width, size.width, accuracy: 1)
                    if let dir, let png = rep.representation(using: .png, properties: [:]) {
                        try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("usage-\(tag)-\(name)-\(scheme == .dark ? "dark" : "light").png"))
                    }
                }
            }
        }
    }
}
