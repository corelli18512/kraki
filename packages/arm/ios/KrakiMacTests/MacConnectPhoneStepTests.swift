#if os(macOS) && DEBUG
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// First-run "Connect your phone" step: when it shows, and how it looks
/// (KRAKI_SNAPSHOT_DIR renders the page in both appearances).
@MainActor
final class MacConnectPhoneStepTests: XCTestCase {
    private var windows: [NSWindow] = []
    override func tearDown() async throws { windows.forEach { $0.close() }; windows.removeAll() }

    private func device(_ id: String, role: DeviceRole, kind: DeviceKind, online: Bool = true) -> DeviceSummary {
        DeviceSummary(id: id, name: id, role: role, kind: kind, publicKey: nil, encryptionKey: nil,
                      online: online, lastSeen: nil, createdAt: nil)
    }

    func testOnlyAnotherPhoneCountsAsHavingAPhone() {
        let mac = device("this-mac-app", role: .app, kind: .desktop)
        let computer = device("computer", role: .tentacle, kind: .desktop)
        let browser = device("browser", role: .app, kind: .web)
        XCTAssertFalse(MacConnectPhoneStep.hasPhone([mac, computer, browser], excluding: "this-mac-app"))
        // An offline phone still means the user already has Kraki on a phone.
        XCTAssertTrue(MacConnectPhoneStep.hasPhone([mac, device("iphone", role: .app, kind: .ios, online: false)], excluding: "this-mac-app"))
        XCTAssertTrue(MacConnectPhoneStep.hasPhone([mac, device("pixel", role: .app, kind: .android)], excluding: "this-mac-app"))
        // This app itself never counts, whatever it reports.
        XCTAssertFalse(MacConnectPhoneStep.hasPhone([device("me", role: .app, kind: .ios)], excluding: "me"))
    }

    func testShowsOnlyAfterFreshSetupOnceTheAccountIsKnown() {
        XCTAssertTrue(MacConnectPhoneStep.shouldShow(pending: true, connected: true, devicesKnown: true, hasPhone: false))
        XCTAssertFalse(MacConnectPhoneStep.shouldShow(pending: false, connected: true, devicesKnown: true, hasPhone: false))
        XCTAssertFalse(MacConnectPhoneStep.shouldShow(pending: true, connected: false, devicesKnown: true, hasPhone: false))
        XCTAssertFalse(MacConnectPhoneStep.shouldShow(pending: true, connected: true, devicesKnown: false, hasPhone: false))
        XCTAssertFalse(MacConnectPhoneStep.shouldShow(pending: true, connected: true, devicesKnown: true, hasPhone: true))
    }

    func testRenderConnectPhoneStep() throws {
        guard let dir = ProcessInfo.processInfo.environment["KRAKI_SNAPSHOT_DIR"] else { throw XCTSkip("set KRAKI_SNAPSHOT_DIR") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("phone-step-\(UUID().uuidString)")
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        let payload = TentacleCLIManager.PairingPayload(
            url: "https://app.kraki.chat?relay=wss%3A%2F%2Frelay.kraki.chat&token=pt_example_not_a_real_code",
            token: "t", relay: "r", expiresAt: Date().addingTimeInterval(280))
        let phone = DeviceSummary(id: "iph", name: "Alex’s iPhone", role: .app, kind: .ios, publicKey: nil,
                                  encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        for dark in [true, false] {
            for (name, connected) in [("waiting", nil as DeviceSummary?), ("connected", phone)] {
                let page = MacConnectPhoneStepPage(preview: payload, previewConnected: connected) {}
                    .environment(app).environment(TentacleCLIManager())
                let host = NSHostingView(rootView: page)
                let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 1180, height: 740),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                window.contentView = host
                window.orderFrontRegardless()
                windows.append(window)
                RunLoop.main.run(until: Date().addingTimeInterval(1.2))
                let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: rep)
                try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                    .write(to: URL(fileURLWithPath: dir).appendingPathComponent("phone-step-\(name)-\(dark ? "dark" : "light").png"))
            }
        }
    }
}
#endif
