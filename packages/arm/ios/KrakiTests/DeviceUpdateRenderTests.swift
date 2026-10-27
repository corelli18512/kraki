#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// The device detail page's update section in every state: what each state
/// shows (title and action rows) is asserted; PNGs for review are written to
/// KRAKI_UPDATE_RENDER_DIR when set.
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

    private typealias Presentation = DeviceUpdateSection.Presentation

    /// Title and action rows per state, in `states` order.
    private let expected: [String: (String, [Presentation.Action])] = [
        "01-available": ("Kraki 0.38.10 is available", [.updateNow(enabled: true)]),
        "02-available-offline": ("Kraki 0.38.10 is available", [.updateNow(enabled: false)]),
        "03-requested": ("Asking Mac mini to update…", []),
        "04-busy": ("2 sessions are running", [.choose]),
        "05-waiting": ("Waiting for sessions to finish", []),
        "06-downloading": ("Downloading Kraki 0.38.10…", []),
        "07-installing": ("Installing Kraki 0.38.10…", []),
        "08-installing-late": ("The update didn’t finish", [.retry, .dismiss]),
        "09-updated": ("Updated to Kraki 0.38.10", []),
        "11-rolled-back": ("Update didn’t work", [.dismiss]),
        "12-failed": ("Couldn’t update", [.retry, .dismiss]),
    ]

    private func store(online: Bool, _ info: DeviceUpdateInfo?, _ progress: DeviceUpdateProgress?) throws -> AppState {
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
        return app
    }

    func testUpdateStatesShowTheirTitleAndActions() throws {
        for (name, online, info, progress) in states {
            let app = try store(online: online, info, progress)
            let shown = DeviceUpdateSection.presentation(device: device(online: online), store: app.deviceStore, now: Date())
            guard let (title, actions) = expected[name] else {
                XCTAssertNil(shown, "\(name) shows no update section")
                XCTAssertFalse(DeviceUpdateSection.isShown(app.deviceStore, id), name)
                continue
            }
            XCTAssertTrue(DeviceUpdateSection.isShown(app.deviceStore, id), name)
            XCTAssertEqual(shown?.title, title, name)
            XCTAssertEqual(shown?.actions, actions, name)
        }
    }

    /// A computer that never comes back from an update (or goes offline
    /// before answering) must not leave the section stuck without Dismiss,
    /// nor keep Remove Device hidden until the app relaunches.
    func testStalledUpdateOfflineOffersDismissAndAllowsRemoval() throws {
        let available = DeviceUpdateInfo(installedVia: "binary", current: "0.38.9", latest: "0.38.10", remote: true)
        let late = Date().addingTimeInterval(-(DeviceUpdateSection.installTimeout + 20))
        for phase in [DeviceUpdateProgress.Phase.requested, .waiting_idle, .downloading, .installing] {
            let progress = DeviceUpdateProgress(phase: phase, from: "0.38.9", to: "0.38.10", at: late)
            let app = try store(online: false, available, progress)
            let shown = DeviceUpdateSection.presentation(device: device(online: false), store: app.deviceStore, now: Date())
            XCTAssertEqual(shown?.title, "Mac mini isn’t back online yet", "\(phase)")
            XCTAssertEqual(shown?.actions, [.dismiss], "\(phase)")
            XCTAssertFalse(DeviceUpdateSection.blocksRemoval(progress, now: Date()), "\(phase)")
        }
        let fresh = DeviceUpdateProgress(phase: .installing, from: "0.38.9", to: "0.38.10")
        XCTAssertTrue(DeviceUpdateSection.blocksRemoval(fresh, now: Date()), "offline mid-update is a restart")
        let shown = DeviceUpdateSection.presentation(device: device(online: false),
                                                     store: try store(online: false, available, fresh).deviceStore, now: Date())
        XCTAssertEqual(shown?.title, "Installing Kraki 0.38.10…")
        XCTAssertFalse(DeviceUpdateSection.blocksRemoval(DeviceUpdateProgress(phase: .failed), now: Date()))
        XCTAssertFalse(DeviceUpdateSection.blocksRemoval(nil, now: Date()))
    }

    /// A slow install never went offline, and the computer reports what it
    /// runs: the timeout copy must not claim it came "back online" or name a
    /// version other than the one it reports.
    func testInstallTimeoutReportsTheComputersCurrentVersion() throws {
        let late = Date().addingTimeInterval(-(DeviceUpdateSection.installTimeout + 20))
        let reported = DeviceUpdateInfo(installedVia: "binary", current: "0.38.9", latest: "0.38.10", remote: true)
        let progress = DeviceUpdateProgress(phase: .installing, from: "0.38.8", to: "0.38.10", at: late)
        let app = try store(online: true, reported, progress)
        let shown = DeviceUpdateSection.presentation(device: device(), store: app.deviceStore, now: Date())
        XCTAssertEqual(shown?.title, "The update didn’t finish")
        XCTAssertEqual(shown?.detail, "Mac mini still runs Kraki 0.38.9.")

        let unknown = try store(online: true, nil, DeviceUpdateProgress(phase: .installing, to: "0.38.10", at: late))
        XCTAssertEqual(DeviceUpdateSection.presentation(device: device(), store: unknown.deviceStore, now: Date())?.detail,
                       "Kraki 0.38.10 wasn’t installed on Mac mini.")
    }

    /// Renders every state (catches crashes); waits for a settled frame and
    /// writes PNGs only when KRAKI_UPDATE_RENDER_DIR is set.
    func testRenderUpdateStates() throws {
        let dir = ProcessInfo.processInfo.environment["KRAKI_UPDATE_RENDER_DIR"]
        for (name, online, info, progress) in states {
            let app = try store(online: online, info, progress)
            for style in dir == nil ? [UIUserInterfaceStyle.light] : [.light, .dark] {
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
                host.view.layoutIfNeeded()
                if let dir {
                    RunLoop.main.run(until: Date().addingTimeInterval(0.8))
                    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                    }
                    if let png = image.pngData() {
                        try png.write(to: URL(fileURLWithPath: dir)
                            .appendingPathComponent("update-\(name)-\(style == .dark ? "dark" : "light").png"))
                    }
                }
                window.isHidden = true
            }
        }
    }
}
#endif
