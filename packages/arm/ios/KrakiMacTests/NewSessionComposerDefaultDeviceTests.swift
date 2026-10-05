#if os(macOS) && DEBUG
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// The new-session composer's default computer follows computers coming
/// online after it appeared, until the user picks one by hand.
@MainActor
final class NewSessionComposerDefaultDeviceTests: XCTestCase {
    private var window: NSWindow?
    private var savedLast: String?

    override func setUp() async throws { savedLast = SessionPrefs.lastDeviceId() }
    override func tearDown() async throws {
        window?.close(); window = nil
        if let savedLast { SessionPrefs.saveLastDevice(savedLast) }
    }

    private func device(_ id: String, online: Bool) -> DeviceSummary {
        DeviceSummary(id: id, name: id, role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil,
                      online: online, lastSeen: nil, createdAt: nil)
    }

    private func spin(_ seconds: TimeInterval = 0.4) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    func testLastUsedComputerComingOnlineLaterBecomesTheDefault() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("composer-\(UUID().uuidString)")
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.deviceStore.devices["office"] = device("office", online: true)
        app.deviceStore.devices["mine"] = device("mine", online: false)
        app.deviceStore.setDeviceAgents("office", agents: [AgentCapabilities(type: "code", id: "pi", models: ["m"], modelDetails: nil)])
        SessionPrefs.saveLastDevice("mine")

        var picked: [String] = []
        let view = NewSessionComposer(onDeviceSelected: { picked.append($0) })
            .environment(app).environment(TentacleCLIManager())
            .frame(width: 640, height: 200)
        let w = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 640, height: 200), styleMask: [.borderless],
                         backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: view)
        w.orderFrontRegardless()
        window = w
        spin()
        XCTAssertEqual(picked.last, "office", "only office is online at first")

        // The last-used computer (e.g. this Mac after a restart) comes online.
        app.deviceStore.setDeviceOnline("mine", online: true)
        spin()
        XCTAssertEqual(picked.last, "mine", "the last-used computer must become the default once it is online")
    }

    func testAHandPickedComputerStays() {
        XCTAssertFalse(NewSessionComposer.followsDefault(userPicked: true, selectedOnline: true))
        XCTAssertTrue(NewSessionComposer.followsDefault(userPicked: true, selectedOnline: false))
        XCTAssertTrue(NewSessionComposer.followsDefault(userPicked: false, selectedOnline: true))
    }
}
#endif
