import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// The sidebar keeps the selected row and the rows being read in view
/// (K-244, K-245). The window is never ordered on screen: SwiftUI still lays
/// it out and scrolls it, so this suite runs in the routine local pass.
@MainActor
final class MacSessionSidebarScrollTests: XCTestCase {
    /// Lets the test change the sidebar's selection like the window does.
    @Observable
    final class Selection {
        var id: String?
    }

    private struct Host: View {
        let selection: Selection
        var body: some View {
            @Bindable var selection = selection
            SessionsSidebarView(selectedSessionId: $selection.id)
        }
    }

    private var windows: [NSWindow] = []
    private var roots: [URL] = []

    override func setUp() {
        super.setUp()
        // Animations do not advance in a window that is never on screen.
        SessionsSidebarView.revealAnimation = nil
    }

    override func tearDown() {
        SessionsSidebarView.revealAnimation = .easeOut(duration: 0.22)
        windows.forEach { $0.contentView = nil }
        windows.removeAll()
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private func scrollView(in view: NSView) -> NSScrollView? {
        if let s = view as? NSScrollView, let doc = s.documentView, doc.frame.height > 200 { return s }
        for sub in view.subviews { if let s = scrollView(in: sub) { return s } }
        return nil
    }

    private func session(_ i: Int, createdAt: Date, pinned: Bool = false) -> SessionInfo {
        SessionInfo(id: "s-\(i)", deviceId: "dev", deviceName: "Mac", agent: "pi", model: "m",
                    title: "Session \(i)", state: .idle, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1,
                    createdAt: createdAt, pinned: pinned)
    }

    /// 40 rows, newest first (s-0 on top). Offscreen window, never shown.
    private func makeSidebar(rows: Int = 40) throws -> (AppState, Selection, NSScrollView) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("sidebar-scroll-\(UUID().uuidString)")
        roots.append(root)
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.testOutboundMessageHandler = { _, _, _ in true }
        let now = Date()
        for i in 0..<rows {
            app.sessionStore.upsertSession(session(i, createdAt: now.addingTimeInterval(Double(-60 * (i + 1)))))
        }
        let selection = Selection()
        let host = NSHostingView(rootView: Host(selection: selection).environment(app))
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 300, height: 500),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        windows.append(window)
        host.layoutSubtreeIfNeeded()
        drain(500)
        XCTAssertFalse(window.isVisible, "the suite never puts a window on screen")
        return (app, selection, try XCTUnwrap(scrollView(in: host), "sidebar scroll view"))
    }

    private func rowHeight(_ sv: NSScrollView, rows: Int = 40) -> CGFloat {
        ((sv.documentView?.frame.height ?? 0) - 8) / CGFloat(rows)
    }

    private func scroll(_ sv: NSScrollView, to y: CGFloat) {
        sv.contentView.scroll(to: NSPoint(x: 0, y: y))
        sv.reflectScrolledClipView(sv.contentView)
        drain(300)
    }

    private func isFullyVisible(_ sv: NSScrollView, row index: Int, rows: Int = 40) -> Bool {
        let h = rowHeight(sv, rows: rows)
        let top = 4 + CGFloat(index) * h
        let visible = sv.contentView.bounds
        return top >= visible.minY - 1 && top + h <= visible.maxY + 1
    }

    // MARK: K-244

    func testSelectingAnOffscreenRowScrollsItIntoView() throws {
        let (_, selection, sv) = try makeSidebar()
        XCTAssertFalse(isFullyVisible(sv, row: 35), "fixture: row 35 starts offscreen")
        // What ⌘1–9, ⌥⌘↓ and a Needs You entry do: set the window's selection.
        selection.id = "s-35"
        drain(700)
        XCTAssertTrue(isFullyVisible(sv, row: 35), "the selected row is brought into view")
    }

    func testSelectingAVisibleRowDoesNotMoveTheList() throws {
        let (_, selection, sv) = try makeSidebar()
        scroll(sv, to: rowHeight(sv) * 10)
        let before = sv.contentView.bounds.minY
        selection.id = "s-12"
        drain(700)
        XCTAssertEqual(sv.contentView.bounds.minY, before, accuracy: 1, "already visible: no scroll")
    }

    func testSelectingARowNotInTheListLeavesNoRevealRequestBehind() throws {
        let (app, selection, _) = try makeSidebar()
        // An archived row, or a notification for a Session Search hides.
        selection.id = "not-in-the-list"
        drain(300)
        XCTAssertNil(app.sessionStore.sessionListRevealId,
                     "no request lingers to move the list when Search is cleared or the row unarchived")
    }

    func testUnpinningTheOpenSessionKeepsItsRowInView() throws {
        let (app, selection, sv) = try makeSidebar()
        // s-30 is pinned (so on top) and open; the list sits at the top.
        app.commandSender?.pinSession(sessionId: "s-30", pinned: true)
        selection.id = "s-30"
        drain(700)
        scroll(sv, to: 0)
        app.sessionStore.sessionListRevealId = nil
        // Session › Unpin Session moves it back to its place far below.
        app.commandSender?.pinSession(sessionId: "s-30", pinned: false)
        drain(700)
        let index = try XCTUnwrap(app.sessionStore.navigationOrderedSessions.firstIndex { $0.id == "s-30" })
        XCTAssertGreaterThan(index, 20, "fixture: the unpinned row moved far down")
        XCTAssertTrue(isFullyVisible(sv, row: index), "the unpinned row is followed into view")
    }

    // MARK: K-245

    func testActivityMovingARowToTheTopDoesNotShiftTheRowsBeingRead() throws {
        let (app, _, sv) = try makeSidebar()
        let h = rowHeight(sv)
        scroll(sv, to: h * 12 + 20)
        let before = sv.contentView.bounds.minY
        // Another device's activity: s-38 (below the viewport) becomes newest.
        app.sessionStore.upsertSession(session(38, createdAt: Date()))
        drain(700)
        XCTAssertEqual(app.sessionStore.navigationOrderedSessions.first?.id, "s-38", "fixture: reordered")
        XCTAssertEqual(sv.contentView.bounds.minY, before + h, accuracy: 2,
                       "the rows on screen stay where they were (one row was added above them)")
    }

    func testSuccessiveReordersKeepTheRowsBeingReadInPlace() throws {
        let (app, _, sv) = try makeSidebar()
        let h = rowHeight(sv)
        // Rows 30–39 are laid out (and their tops recorded) on the way down.
        scroll(sv, to: (sv.documentView?.frame.height ?? 0) - sv.contentView.bounds.height)
        scroll(sv, to: h * 12 + 20)
        let before = sv.contentView.bounds.minY
        for (n, moved) in [35, 36].enumerated() {
            app.sessionStore.upsertSession(session(moved, createdAt: Date()))
            drain(700)
            XCTAssertEqual(app.sessionStore.navigationOrderedSessions.first?.id, "s-\(moved)", "fixture: reordered")
            XCTAssertEqual(sv.contentView.bounds.minY, before + CGFloat(n + 1) * h, accuracy: 2,
                           "reorder \(n + 1): the rows on screen stay where they were")
        }
    }

    func testAtTheTopTheRowThatMovedUpIsShown() throws {
        let (app, _, sv) = try makeSidebar()
        XCTAssertEqual(sv.contentView.bounds.minY, 0, accuracy: 1)
        app.sessionStore.upsertSession(session(38, createdAt: Date()))
        drain(700)
        XCTAssertEqual(sv.contentView.bounds.minY, 0, accuracy: 1, "a list at the top stays at the top")
    }
}
