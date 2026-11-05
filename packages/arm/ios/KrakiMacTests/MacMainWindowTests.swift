import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Main window behaviour around New Session, the Delete confirmation, the
/// connection notice and narrow/zoomed windows. The window is laid out but
/// never put on screen (borderless, off-screen, never ordered in); only the
/// Delete confirmation test presents a real sheet, so it runs with the
/// window suite (KRAKI_RUN_UI_TESTS=1, CI).
@MainActor
final class MacMainWindowTests: XCTestCase {
    private let device = "main-window-tentacle"
    private var root: URL!
    private var app: AppState!
    private var window: NSWindow?
    private var selections: [String?] = []
    private var savedInspectorShown: Any?

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    override func setUpWithError() throws {
        try super.setUpWithError()
        // Keep the shared machine-local window/zoom file out of this suite.
        setenv("KRAKI_RENDER_BUBBLE_TEST", "1", 1)
        savedInspectorShown = UserDefaults.standard.object(forKey: "mac.inspectorShown")
        UserDefaults.standard.set(false, forKey: "mac.inspectorShown")
        MacNewSessionRequest.pending = false
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-main-window-\(UUID().uuidString)")
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.deviceStore.addDevice(DeviceSummary(id: device, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        for (i, id) in ["s1", "s2", "s3"].enumerated() {
            app.sessionStore.sessions[id] = SessionInfo(
                id: id, deviceId: device, deviceName: "Mac", agent: "pi", title: "Session \(id)",
                state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
                createdAt: Date().addingTimeInterval(Double(-60 * i)), pinned: false)
        }
    }

    override func tearDown() {
        window?.contentView = nil
        window = nil
        app = nil
        MacNewSessionRequest.pending = false
        if let savedInspectorShown {
            UserDefaults.standard.set(savedInspectorShown, forKey: "mac.inspectorShown")
        } else {
            UserDefaults.standard.removeObject(forKey: "mac.inspectorShown")
        }
        unsetenv("KRAKI_RENDER_BUBBLE_TEST")
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    @discardableResult
    private func mount(selected: String? = "s1", width: CGFloat = 1100, zoomed: Bool = false) -> NSWindow {
        let main = MainWindowView(initialSelectedSessionId: selected,
                                  selectionNotificationScope: "mac-main-window-tests",
                                  onSelectedSessionChanged: { [weak self] in self?.selections.append($0) })
            .environment(app).environment(TentacleCLIManager())
        let host: NSView = zoomed ? NSHostingView(rootView: main.windowZoom()) : NSHostingView(rootView: main)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: 700),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        self.window = window
        drain(800)
        XCTAssertFalse(window.isVisible, "the suite never puts a window on screen")
        return window
    }

    private var currentSelection: String?? { selections.last }

    // MARK: K-336 — Session › New Session with the main window closed

    func testNewSessionWithNoMainWindowOpensTheWindowOnANewSession() throws {
        var opened = 0
        MacNewSessionRequest.request { opened += 1 }
        XCTAssertEqual(opened, 1, "nothing received the request: the main window is opened")
        XCTAssertTrue(MacNewSessionRequest.pending)

        // The window opens on the last Session, then takes the request.
        mount(selected: "s1")
        XCTAssertEqual(currentSelection, .some(nil), "the window starts a new Session")
        XCTAssertFalse(MacNewSessionRequest.pending, "the request is taken once")
    }

    func testNewSessionWithTheMainWindowOpenStaysInIt() throws {
        mount(selected: "s1")
        var opened = 0
        MacNewSessionRequest.request { opened += 1 }
        drain(200)
        XCTAssertEqual(opened, 0, "the open window received it")
        XCTAssertFalse(MacNewSessionRequest.pending)
        XCTAssertEqual(currentSelection, .some(nil))
    }

    // MARK: K-247 — no chat switch behind the Delete confirmation

    func testSessionSwitchesWaitForTheDeleteConfirmation() throws {
        try requireForegroundUITests() // the confirmation is a real sheet on the test window
        mount(selected: "s1")
        selections.removeAll()
        NotificationCenter.default.post(name: .macDeleteSession, object: nil, userInfo: ["sessionId": "s1"])
        drain(300)

        MacNewSessionRequest.request {}
        NotificationCenter.default.post(name: .macNavigateSession, object: nil, userInfo: ["index": 2])
        NotificationCenter.default.post(name: .macSelectSession, object: nil,
                                        userInfo: ["sessionId": "s2", "scope": "mac-main-window-tests"])
        drain(300)
        XCTAssertTrue(selections.isEmpty, "the chat behind 'Delete this session?' stays the one being deleted")
        XCTAssertFalse(MacNewSessionRequest.pending, "the request is not kept for later either")
    }

    // MARK: K-254 — the connection notice does not push the list

    func testConnectionNoticeDoesNotMoveTheSessionList() throws {
        let window = mount(selected: "s1")
        let list = try XCTUnwrap(sidebarScrollView(in: try XCTUnwrap(window.contentView)))
        let before = list.convert(list.bounds, to: nil)

        app.connectionStatus = .connecting
        drain(Int((AppState.reconnectingIndicatorDelay + 0.6) * 1000))
        XCTAssertNotNil(app.connectionNotice, "fixture: the notice is shown")
        let shown = list.convert(list.bounds, to: nil)
        XCTAssertEqual(shown.maxY, before.maxY, accuracy: 0.5, "the list's top edge stays put")
        XCTAssertEqual(shown.height, before.height, accuracy: 0.5)
    }

    private func sidebarScrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView, !(scroll is MacChatScrollView),
           scroll.frame.width <= MacMainWindowColumns.sidebarWidth + 1 { return scroll }
        for sub in view.subviews { if let s = sidebarScrollView(in: sub) { return s } }
        return nil
    }

    // MARK: K-113 — narrow and zoomed windows keep a readable chat column

    func testColumnsFoldAwayBeforeTheChatColumnGetsUnreadable() {
        let both = MacMainWindowColumns.resolve(width: 800, sidebarRequested: true, inspectorRequested: true)
        XCTAssertEqual(both, MacMainWindowColumns(showsSidebar: true, showsInspector: false),
                       "at the 800 pt minimum the Inspector gives way first")
        XCTAssertEqual(MacMainWindowColumns.resolve(width: 1100, sidebarRequested: true, inspectorRequested: true),
                       MacMainWindowColumns(showsSidebar: true, showsInspector: true))
        // 800 pt at zoom 1.6 = 500 layout points.
        XCTAssertEqual(MacMainWindowColumns.resolve(width: 500, sidebarRequested: true, inspectorRequested: false),
                       MacMainWindowColumns(showsSidebar: false, showsInspector: false))
        XCTAssertEqual(MacMainWindowColumns.resolve(width: 0, sidebarRequested: true, inspectorRequested: true),
                       MacMainWindowColumns(showsSidebar: true, showsInspector: true), "not measured yet")
        for width in stride(from: CGFloat(400), through: 2000, by: 10) {
            for sidebar in [false, true] {
                for inspector in [false, true] {
                    let c = MacMainWindowColumns.resolve(width: width, sidebarRequested: sidebar, inspectorRequested: inspector)
                    let chat = width - (c.showsSidebar ? 281 : 0) - (c.showsInspector ? 321 : 0)
                    XCTAssertGreaterThanOrEqual(chat, min(width, MacMainWindowColumns.minimumChatWidth))
                }
            }
        }
    }

    func testShowingTheInspectorGrowsAMinimumWidthWindow() throws {
        let window = mount(selected: "s1", width: 800)
        XCTAssertEqual(window.frame.width, 800, accuracy: 0.5)
        UserDefaults.standard.set(true, forKey: "mac.inspectorShown")   // View › Show Inspector
        drain(500)
        XCTAssertGreaterThanOrEqual(window.frame.width,
                                    MacMainWindowColumns.requiredWidth(sidebarRequested: true, inspectorRequested: true) - 0.5,
                                    "the window makes room for the Inspector beside a readable chat")
    }

    func testZoomingInGrowsAMinimumWidthWindow() throws {
        let window = mount(selected: "s1", width: 800, zoomed: true)
        for _ in 0..<6 { NotificationCenter.default.post(name: .macZoomIn, object: nil); drain(150) }
        drain(400)
        let needed = MacMainWindowColumns.requiredWidth(sidebarRequested: true, inspectorRequested: false) * 1.6
        XCTAssertGreaterThanOrEqual(window.frame.width, needed - 1, "zoom 1.6 keeps the sidebar and a readable chat")
    }

    func testAWindowSizedByHandIsNotGrownBack() throws {
        let window = mount(selected: "s1", width: 1100)
        UserDefaults.standard.set(true, forKey: "mac.inspectorShown")
        drain(400)
        window.setFrame(NSRect(x: window.frame.minX, y: window.frame.minY, width: 820, height: 700), display: true)
        drain(500)
        XCTAssertEqual(window.frame.width, 820, accuracy: 0.5, "resizing is the person's choice")
    }
}
