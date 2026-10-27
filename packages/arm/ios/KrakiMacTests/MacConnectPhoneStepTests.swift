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

    private func find(_ identifier: String, in element: AnyObject) -> AnyObject? {
        find(in: element) { $0.accessibilityIdentifier?() == identifier }
    }

    private func find(in element: AnyObject, where matches: (AnyObject) -> Bool) -> AnyObject? {
        if matches(element) { return element }
        for child in element.accessibilityChildren?() ?? [] {
            if let found = find(in: child as AnyObject, where: matches) { return found }
        }
        return nil
    }

    /// Through the real overlay: the phone joining is the step's success
    /// state, so it must not take the step away; only finishing ends it.
    func testStepStaysUpWhenThePhoneJoinsUntilTheUserFinishes() throws {
        DeviceTrustTesting.localKrakiHome = FileManager.default.temporaryDirectory.appendingPathComponent("no-local-computer")
        defer { DeviceTrustTesting.localKrakiHome = nil }
        let suite = "MacConnectPhoneStepTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: MacConnectPhoneStep.pendingKey)

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("phone-step-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.deviceId = "this-mac-app"
        app.deviceStore.devices["this-mac-app"] = device("this-mac-app", role: .app, kind: .desktop)
        app.connectionStatus = .connected

        let host = NSHostingView(rootView: MacConnectPhoneStep()
            .environment(app).environment(TentacleCLIManager()).defaultAppStorage(defaults))
        let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 1180, height: 740),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFrontRegardless()
        windows.append(window)
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        XCTAssertNotNil(find("mac.setup.phone", in: host), "the step shows after a fresh setup")

        app.deviceStore.devices["iphone"] = device("iphone", role: .app, kind: .ios)
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        XCTAssertNotNil(find("mac.setup.phone", in: host), "a joining phone must not remove the step")
        XCTAssertTrue(defaults.bool(forKey: MacConnectPhoneStep.pendingKey))

        // A reconnect while the step is up neither hides it nor ends it.
        app.connectionStatus = .disconnected
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        app.connectionStatus = .connected
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        XCTAssertNotNil(find("mac.setup.phone", in: host))
        XCTAssertTrue(defaults.bool(forKey: MacConnectPhoneStep.pendingKey))

        // The step's container identifier covers its buttons; find Skip by role and title.
        let finish = try XCTUnwrap(find(in: host) {
            $0.accessibilityRole?() == .button
                && ($0.accessibilityTitle?() == "Skip for Now" || $0.accessibilityLabel?() == "Skip for Now")
        })
        XCTAssertTrue(finish.accessibilityPerformPress?() ?? false)
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))
        XCTAssertFalse(defaults.bool(forKey: MacConnectPhoneStep.pendingKey), "finishing ends the step for good")
        XCTAssertNil(find("mac.setup.phone", in: host))
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
