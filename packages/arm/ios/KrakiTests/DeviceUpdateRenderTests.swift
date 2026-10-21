#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// Renders the device detail page's update section in every state for review.
/// Writes PNGs to KRAKI_UPDATE_RENDER_DIR when set.
@MainActor
final class DeviceUpdateRenderTests: XCTestCase {
    private let id = "mini"

    private func app() throws -> AppState {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("update-\(UUID().uuidString).sqlite")))
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        return app
    }

    private func device(online: Bool = true) -> DeviceSummary {
        DeviceSummary(id: id, name: "Mac mini", role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil,
                      online: online, lastSeen: nil, createdAt: "2026-09-01T00:00:00.000Z")
    }

    /// (name, online, update info, progress)
    private var states: [(String, Bool, DeviceUpdateInfo?, DeviceUpdateProgress?)] {
        let available = DeviceUpdateInfo(installedVia: "binary", current: "0.38.9", latest: "0.38.10", remote: true)
        let current = DeviceUpdateInfo(installedVia: "binary", current: "0.38.10", remote: true)
        return [
            ("01-available", true, available, nil),
            ("02-available-offline", false, available, nil),
            ("03-requested", true, available, DeviceUpdateProgress(phase: .requested, from: "0.38.9", to: "0.38.10")),
            ("04-busy", true, available, DeviceUpdateProgress(phase: .busy, from: "0.38.9", to: "0.38.10", runningSessions: 2)),
            ("05-waiting", true, available, DeviceUpdateProgress(phase: .waiting_idle, from: "0.38.9", to: "0.38.10")),
            ("06-downloading", true, available, DeviceUpdateProgress(phase: .downloading, from: "0.38.9", to: "0.38.10", progress: 0.42)),
            ("07-installing", false, available, DeviceUpdateProgress(phase: .installing, from: "0.38.9", to: "0.38.10")),
            ("08-installing-late", true, available, DeviceUpdateProgress(phase: .installing, from: "0.38.9", to: "0.38.10",
                                                                         at: Date().addingTimeInterval(-200))),
            ("09-updated", true, current, DeviceUpdateProgress(phase: .updated, from: "0.38.9", to: "0.38.10")),
            ("10-up-to-date", true, current, nil),
            ("11-rolled-back", true, available, DeviceUpdateProgress(phase: .rolled_back, from: "0.38.9", to: "0.38.10")),
            ("12-failed", true, available, DeviceUpdateProgress(phase: .failed, from: "0.38.9", to: "0.38.10",
                                                                 error: "The download didn’t finish. Nothing was changed.")),
        ]
    }

    func testRenderUpdateStates() throws {
        let dir = ProcessInfo.processInfo.environment["KRAKI_UPDATE_RENDER_DIR"]
        for (name, online, info, progress) in states {
            let app = try app()
            let store = app.deviceStore
            store.setDevices([device(online: online)])
            if online {
                store.setGreeting(id, name: "Mac mini",
                                  agents: [AgentCapabilities(type: "code", id: "pi", models: ["m"], modelDetails: nil)],
                                  version: info?.current ?? "0.38.9")
            }
            if let info { store.setDeviceUpdate(id, update: info) }
            store.setUpdateProgress(id, progress)
            for style in [UIUserInterfaceStyle.light, .dark] {
                let host = UIHostingController(rootView: NavigationStack {
                    DeviceDetailView(device: device(online: online))
                }.environment(app))
                host.overrideUserInterfaceStyle = style
                let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 402, height: 700)
                window.windowLevel = .alert + 1
                window.overrideUserInterfaceStyle = style
                window.rootViewController = host
                window.makeKeyAndVisible()
                RunLoop.main.run(until: Date().addingTimeInterval(0.8))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                if let dir, let png = image.pngData() {
                    try png.write(to: URL(fileURLWithPath: dir)
                        .appendingPathComponent("update-\(name)-\(style == .dark ? "dark" : "light").png"))
                }
                window.isHidden = true
            }
        }
    }
}
#endif
