#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// Renders the Devices tab (Accounts section) with sample data for visual review.
/// Writes PNGs to KRAKI_USAGE_RENDER_DIR when set.
@MainActor
final class AccountUsageRenderTests: XCTestCase {
    private func device(_ id: String, _ name: String, online: Bool = true) -> DeviceSummary {
        DeviceSummary(id: id, name: name, role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil,
                      online: online, lastSeen: nil, createdAt: nil)
    }
    private func window(_ kind: String, _ remaining: Double, hours: Double) -> AccountUsageWindow {
        AccountUsageWindow(id: kind == "five_hour" ? "five_hour" : "seven_day", kind: kind, remainingPercent: remaining,
                           resetsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(hours * 3600)),
                           durationSeconds: kind == "five_hour" ? 18000 : 604800)
    }
    private func account(_ key: String, _ provider: String, _ label: String, _ plan: String, _ w: [AccountUsageWindow], error: String? = nil, ageHours: Double = 0) -> AccountUsage {
        AccountUsage(accountKey: key, provider: provider, label: label, plan: plan, windows: w,
                     fetchedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-ageHours * 3600)), error: error, agents: ["pi"])
    }

    func testRenderDevicesTab() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-usage-render-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        let store = app.deviceStore
        store.setDevices([device("mbp", "MacBook Pro"), device("mini", "Mac mini"), device("srv", "build-server"),
                          device("old", "Old laptop", online: false)])
        let claudeMain = account("claude:1", "claude", "co•••ai@gmail.com", "default_claude_max_20x", [window("five_hour", 87, hours: 2.3), window("weekly", 64, hours: 52)])
        store.setDeviceUsage("mbp", accounts: [claudeMain,
            account("codex:1", "codex", "co•••12@outlook.com", "prolite", [window("weekly", 0, hours: 141)])])
        store.setDeviceUsage("mini", accounts: [claudeMain,
            account("codex:2", "codex", "co•••ai@gmail.com", "prolite", [window("weekly", 41, hours: 134)])])
        store.setDeviceUsage("srv", accounts: [claudeMain,
            account("claude:2", "claude", "wo•••rk@studio.dev", "default_claude_max_5x", [window("five_hour", 9, hours: 0.6), window("weekly", 71, hours: 98)], error: "auth", ageHours: 1.5)])
        let dir = ProcessInfo.processInfo.environment["KRAKI_USAGE_RENDER_DIR"]
        for style in [UIUserInterfaceStyle.light, .dark] {
            let view = NavigationStack { DeviceListView() }.environment(app)
            let host = UIHostingController(rootView: view)
            host.overrideUserInterfaceStyle = style
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
            window.windowLevel = .alert + 1
            window.overrideUserInterfaceStyle = style
            window.rootViewController = host
            window.makeKeyAndVisible()
            RunLoop.main.run(until: Date().addingTimeInterval(1.6))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            XCTAssertGreaterThan(image.size.width, 0)
            if let dir, let png = image.pngData() {
                try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ios-devices-\(style == .dark ? "dark" : "light").png"))
            }
            window.isHidden = true
        }
    }

    /// The three cases a user can be in: no Claude/Codex subscription signed in
    /// anywhere, computers whose CLI predates account usage, and accounts present.
    /// Devices and a device's detail page show the Accounts section only when
    /// an account has reported (counted in the rendered List, not a helper).
    func testRenderAccountsEmptyStates() throws {
        let dir = ProcessInfo.processInfo.environment["KRAKI_USAGE_RENDER_DIR"]
        let usage = account("claude:1", "claude", "co•••ai@gmail.com", "default_claude_max_20x",
                            [window("five_hour", 87, hours: 2.3), window("weekly", 64, hours: 52)])
        var detailSections: [String: Int] = [:]
        for (name, features, accounts) in [("none", ["account_usage", "account_usage_refresh"], [AccountUsage]()),
                                           ("old-cli", [String](), [AccountUsage]()),
                                           ("accounts", ["account_usage", "account_usage_refresh"], [usage])] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-usage-empty-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: root) }
            let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
            app.connectionStatus = .connected
            app.testOutboundMessageHandler = { _, _, _ in true }
            let store = app.deviceStore
            store.setDevices([device("mbp", "MacBook Pro"), device("mini", "Mac mini"), device("old", "Old laptop", online: false)])
            for id in ["mbp", "mini"] {
                store.setGreeting(id, name: store.devices[id]?.name ?? id,
                                  agents: [AgentCapabilities(type: "code", id: "pi", models: ["m"], modelDetails: nil)], version: "0.38.10")
                store.setDeviceFeatures(id, features: features)
                if !features.isEmpty { store.setDeviceUsage(id, accounts: accounts) }
            }
            for style in [UIUserInterfaceStyle.light, .dark] {
                let (image, sections) = try render(NavigationStack { DeviceListView() }.environment(app), style: style)
                // Online and Offline, plus Accounts only when an account reported.
                XCTAssertEqual(sections, accounts.isEmpty ? 2 : 3, "\(name): Devices shows Accounts only when there is something to show")
                if let dir, let png = image.pngData() {
                    try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ios-devices-\(name)-\(style == .dark ? "dark" : "light").png"))
                }
            }
            let mbp = try XCTUnwrap(store.devices["mbp"])
            detailSections[name] = try render(NavigationStack { DeviceDetailView(device: mbp) }.environment(app), style: .light).sections
        }
        let base = try XCTUnwrap(detailSections["old-cli"])
        XCTAssertEqual(detailSections["none"], base, "detail page: no empty Accounts card for a CLI with no accounts")
        XCTAssertEqual(detailSections["accounts"], base + 1, "detail page: Accounts when the device reported one")
    }

    /// Renders `view` in a window; returns the image and the number of
    /// sections in its List.
    private func render(_ view: some View, style: UIUserInterfaceStyle) throws -> (image: UIImage, sections: Int) {
        let host = UIHostingController(rootView: view)
        host.overrideUserInterfaceStyle = style
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = style
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        func all(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(all) }
        let lists = all(host.view).compactMap { $0 as? UICollectionView }
        XCTAssertEqual(lists.count, 1, "one List on the page")
        return (image, lists.reduce(0) { $0 + $1.numberOfSections })
    }

    /// Three accounts (Claude Max, Codex, a Claude account needing sign-in),
    /// scrolled to the Accounts section, for proportion review.
    func testRenderThreeAccounts() throws {
        let dir = ProcessInfo.processInfo.environment["KRAKI_USAGE_RENDER_DIR"]
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-usage-three-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        let store = app.deviceStore
        store.setDevices([device("mbp", "MacBook Pro"), device("mini", "Mac mini"), device("old", "Old laptop", online: false)])
        for id in ["mbp", "mini"] {
            store.setGreeting(id, name: store.devices[id]?.name ?? id,
                              agents: [AgentCapabilities(type: "code", id: "pi", models: ["m"], modelDetails: nil)], version: "0.38.10")
            store.setDeviceFeatures(id, features: ["account_usage", "account_usage_refresh"])
        }
        store.setDeviceUsage("mbp", accounts: [
            account("claude:1", "claude", "co•••ai@gmail.com", "default_claude_max_20x", [window("five_hour", 87, hours: 2.3), window("weekly", 64, hours: 52)]),
            account("codex:1", "codex", "co•••12@outlook.com", "prolite", [window("weekly", 23, hours: 141)])])
        store.setDeviceUsage("mini", accounts: [
            account("claude:1", "claude", "co•••ai@gmail.com", "default_claude_max_20x", [window("five_hour", 87, hours: 2.3), window("weekly", 64, hours: 52)]),
            account("claude:2", "claude", "wo•••rk@studio.dev", "default_claude_max_5x", [window("five_hour", 9, hours: 0.6), window("weekly", 71, hours: 98)], error: "auth", ageHours: 1.5)])
        // Idle header: Mac mini refreshed 30 s ago (cool-down), MacBook Pro may refresh manually.
        for (id, ago) in [("mini", 30.0), ("mbp", 120.0)] {
            store.beginUsageRefresh(id, requestId: "r-\(id)", now: Date().addingTimeInterval(-ago))
            store.finishUsageRefresh(id, requestId: "r-\(id)")
        }
        for style in [UIUserInterfaceStyle.light, .dark] {
            let host = UIHostingController(rootView: NavigationStack { DeviceListView() }.environment(app))
            host.overrideUserInterfaceStyle = style
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
            window.windowLevel = .alert + 1
            window.overrideUserInterfaceStyle = style
            window.rootViewController = host
            window.makeKeyAndVisible()
            RunLoop.main.run(until: Date().addingTimeInterval(1.0))
            func all(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(all) }
            if let scroll = all(host.view).compactMap({ $0 as? UICollectionView }).first {
                scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)), animated: false)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(1.4))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            if let dir, let png = image.pngData() {
                try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ios-three-\(style == .dark ? "dark" : "light").png"))
            }
            window.isHidden = true
        }
    }

    @Observable final class RefreshDemo { var busy = false; var ready = true; var failed = false }

    /// The refresh glyph in each state, and frames of idle → spin → check.
    func testRenderRefreshButtonStates() throws {
        let dir = ProcessInfo.processInfo.environment["KRAKI_USAGE_RENDER_DIR"]
        let demo = RefreshDemo()
        struct Row: View {
            let title: String; let busy: Bool; let ready: Bool
            var body: some View {
                HStack { Text(title).font(.footnote).foregroundStyle(.secondary); Spacer()
                    UsageRefreshButton(busy: busy, ready: ready) {} }
            }
        }
        struct Live: View {
            let demo: RefreshDemo
            var body: some View {
                HStack { Text("Accounts").foregroundStyle(.secondary); Spacer()
                    UsageRefreshButton(busy: demo.busy, ready: demo.ready, failed: demo.failed) {} }
            }
        }
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let view = List {
                Section("States") {
                    Row(title: "Ready", busy: false, ready: true)
                    Row(title: "Refreshing (spins)", busy: true, ready: true)
                    Row(title: "Cool-down (dimmed)", busy: false, ready: false)
                }
                Section { Text("Row") } header: { Live(demo: demo).textCase(nil) }
            }.listStyle(.insetGrouped)
            let host = UIHostingController(rootView: view)
            host.overrideUserInterfaceStyle = style
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 402, height: 520)
            window.windowLevel = .alert + 1
            window.overrideUserInterfaceStyle = style
            window.rootViewController = host
            window.makeKeyAndVisible()
            demo.busy = false
            RunLoop.main.run(until: Date().addingTimeInterval(1.0))
            func frame(_ name: String) throws {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                if let dir, let png = image.pngData() {
                    try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("refresh-\(suffix)-\(name).png"))
                }
            }
            try frame("00")
            demo.busy = true
            for i in 1...10 { RunLoop.main.run(until: Date().addingTimeInterval(0.08)); try frame(String(format: "%02d", i)) }
            demo.busy = false
            for i in 11...22 { RunLoop.main.run(until: Date().addingTimeInterval(0.08)); try frame(String(format: "%02d", i)) }
            RunLoop.main.run(until: Date().addingTimeInterval(1.0)); try frame("23")
            window.isHidden = true
        }
    }
}
#endif
