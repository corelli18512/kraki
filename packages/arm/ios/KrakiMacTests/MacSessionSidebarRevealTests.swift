import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// A newly created Session is brought into view with the MINIMUM scroll: the
/// sidebar never jumps to the top, and never moves when the row is visible.
@MainActor
final class MacSessionSidebarRevealTests: XCTestCase {
    private var windows: [NSWindow] = []
    override func tearDown() {
        windows.forEach { $0.orderOut(nil) }
        windows.removeAll()
        super.tearDown()
    }
    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func scrollView(in view: NSView) -> NSScrollView? {
        if let s = view as? NSScrollView, s.documentView != nil, s.documentView!.frame.height > 200 { return s }
        for sub in view.subviews { if let s = scrollView(in: sub) { return s } }
        return nil
    }

    private func makeSidebar(pinned: Int) throws -> (AppState, NSScrollView) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("sidebar-\(UUID().uuidString)")
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.deviceStore.devices["dev"] = DeviceSummary(id: "dev", name: "Mac", role: .tentacle, kind: .desktop,
                                                       publicKey: nil, encryptionKey: nil, online: true,
                                                       lastSeen: nil, createdAt: nil)
        for i in 0..<pinned {
            app.sessionStore.upsertSession(SessionInfo(
                id: "pinned-\(i)", deviceId: "dev", deviceName: "Mac", agent: "pi", model: "m",
                title: "Pinned \(i)", state: .idle, mode: .discuss, lastSeq: 1, readSeq: 1, messageCount: 1,
                createdAt: Date().addingTimeInterval(Double(-60 * (i + 1))), pinned: true))
        }
        for i in 0..<5 {
            app.sessionStore.upsertSession(SessionInfo(
                id: "old-\(i)", deviceId: "dev", deviceName: "Mac", agent: "pi", model: "m",
                title: "Old \(i)", state: .idle, mode: .discuss, lastSeq: 1, readSeq: 1, messageCount: 1,
                createdAt: Date().addingTimeInterval(Double(-86_400 - 60 * i)), pinned: false))
        }
        var selected: String?
        let binding = Binding(get: { selected }, set: { selected = $0 })
        let host = NSHostingView(rootView: SessionsSidebarView(selectedSessionId: binding).environment(app))
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 320, height: 520),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFrontRegardless()
        windows.append(window)
        drain(600)
        return (app, try XCTUnwrap(scrollView(in: host), "sidebar scroll view"))
    }

    private func createNewSession(_ app: AppState) {
        app.sessionStore.upsertSession(SessionInfo(
            id: "new", deviceId: "dev", deviceName: "Mac", agent: "pi", model: "m",
            title: "Brand new", state: .idle, mode: .discuss, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: Date(), pinned: false))
        app.sessionStore.sessionListRevealId = "new"
        drain(900)
    }

    func testNewSessionBelowManyPinnedIsRevealedWithMinimalScroll() throws {
        let (app, sv) = try makeSidebar(pinned: 25)
        let visible = sv.contentView.bounds.height
        let rowHeight = sv.documentView!.frame.height / 30
        XCTAssertLessThan(visible, rowHeight * 25, "fixture: pinned rows overflow the sidebar")
        XCTAssertEqual(sv.contentView.bounds.minY, 0, accuracy: 1)
        createNewSession(app)
        let offset = sv.contentView.bounds.minY
        let rowTop = rowHeight * 25   // first row after 25 pinned
        XCTAssertGreaterThan(offset, 0, "the new row is brought into view")
        XCTAssertLessThan(offset, rowTop - rowHeight, "not aligned to the top: pinned rows above stay in view")
        XCTAssertGreaterThanOrEqual(offset + visible, rowTop + rowHeight - 4, "the new row is fully visible")
    }

    func testVisibleNewSessionDoesNotMoveTheSidebar() throws {
        let (app, sv) = try makeSidebar(pinned: 2)
        let before = sv.contentView.bounds.minY
        createNewSession(app)
        XCTAssertEqual(sv.contentView.bounds.minY, before, accuracy: 1, "already visible: no scroll")
    }
}
