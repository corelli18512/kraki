#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// Devices list and a computer's page: same-named computers (K-191), and a
/// computer removed from the account while its page is open (K-193).
@MainActor
final class DeviceDetailNavigationTests: XCTestCase {
    @Observable final class Nav { var path: [DeviceNavID] = [] }

    private struct Host: View {
        @Bindable var nav: Nav
        var body: some View {
            NavigationStack(path: $nav.path) { DeviceListView() }
        }
    }

    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func settle(_ seconds: TimeInterval = 0.8) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// K-191: two computers with the same name are marked so their rows
    /// can show a short id (and the list a rename hint).
    func testComputersSharingANameAreMarked() {
        let devices = [
            DeviceSummary(id: "dev_aaaaaa111111", name: "Build Server", role: .tentacle, online: true),
            DeviceSummary(id: "dev_bbbbbb222222", name: "Build Server", role: .tentacle, online: false),
            DeviceSummary(id: "dev_cccccc333333", name: "Mac mini", role: .tentacle, online: true),
        ]
        XCTAssertEqual(DeviceListView.sameNameDeviceIds(devices), ["dev_aaaaaa111111", "dev_bbbbbb222222"])
        XCTAssertTrue(DeviceListView.sameNameDeviceIds(Array(devices.suffix(2))).isEmpty)
    }

    func testRemovedDevicePageClosesBackToTheList() throws {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("device-nav-\(UUID().uuidString).sqlite")))
        app.deviceStore.setDevices([
            DeviceSummary(id: "gone", name: "Old box", role: .tentacle, online: false),
            DeviceSummary(id: "kept", name: "Mac mini", role: .tentacle, online: true),
        ])
        let nav = Nav()
        let host = UIHostingController(rootView: Host(nav: nav).environment(app))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 800)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        settle()

        nav.path = [DeviceNavID(id: "gone")]
        settle()
        XCTAssertEqual(nav.path, [DeviceNavID(id: "gone")])

        app.messageRouter?.handleRawMessage(try JSONSerialization.data(withJSONObject: ["type": "device_removed", "deviceId": "gone"]))
        settle()
        XCTAssertTrue(nav.path.isEmpty, "the removed device's page is still on the stack")
    }
}
#endif
