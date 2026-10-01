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
}
#endif
