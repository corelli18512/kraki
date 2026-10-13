import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// 2-07 (review group 2, 2026-10-13): the open Session deleted elsewhere
/// (Session Info, another device) must not keep its chat and composer mounted.
@MainActor
final class MacDeletedOpenSessionTests: XCTestCase {
    private let device = "deleted-session-tentacle"
    private let sid = "open-then-deleted"
    private var root: URL!
    private var app: AppState!
    private var window: NSWindow!
    private var selections: [String?] = []

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    override func setUpWithError() throws {
        try requireForegroundUITests() // puts a real window on screen
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-deleted-\(UUID().uuidString)")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        app = AppState(testDatabase: db)
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.deviceStore.addDevice(DeviceSummary(id: device, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: device, deviceName: "Mac", agent: "pi", title: "Doomed",
            state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: Date(), pinned: false
        )
        let view = MainWindowView(initialSelectedSessionId: sid,
                                  selectionNotificationScope: "deleted-open-session",
                                  onSelectedSessionChanged: { [weak self] in self?.selections.append($0) })
            .environment(app).environment(TentacleCLIManager())
        window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 1100, height: 700),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        drain(800)
    }

    override func tearDown() {
        window?.orderOut(nil); window?.contentView = nil; window = nil; app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    func testRemotelyDeletedOpenSessionClosesItsChat() throws {
        XCTAssertEqual(app.sessionSubscriptionController.desiredSessionId, sid, "the chat is open")

        // What `session_deleted` (from another device or Session Info) does.
        app.sessionStore.removeSession(sid)
        drain(400)

        XCTAssertEqual(selections.last, .some(nil), "the selection is cleared")
        XCTAssertNil(app.sessionSubscriptionController.desiredSessionId, "the live subscription is released")
    }
}
