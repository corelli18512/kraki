#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// Two-column Sessions layout on wide windows (iPhone Duo inner display, iPad):
/// the list beside the open chat, as on Mac. Folding keeps the same chat.
@MainActor
final class SessionSplitLayoutTests: XCTestCase {
    private var fixtures = ChatUXRegressionTests()
    private var window: UIWindow!

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    override func tearDown() async throws {
        window?.isHidden = true; window = nil
        try await fixtures.tearDown()
        try await super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func all(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(all) }

    private func accessible(_ id: String) -> [NSObject] {
        var out: [NSObject] = []
        func walk(_ o: NSObject) {
            if (o as? UIAccessibilityIdentification)?.accessibilityIdentifier == id || o.accessibilityLabel == id { out.append(o) }
            var kids: [NSObject] = (o as? UIView)?.subviews ?? []
            let n = o.accessibilityElementCount()
            if n != NSNotFound, n > 0 { kids += (0..<n).compactMap { o.accessibilityElement(at: $0) as? NSObject } }
            kids.forEach(walk)
        }
        walk(window)
        return out
    }

    private func marked(_ id: String) -> [UIView] {
        all(window).filter { $0.accessibilityIdentifier == id && $0.window != nil && !$0.isHiddenOrHasHiddenAncestor }
    }

    private var chats: [ChatPerfListVC] {
        all(window).compactMap { v in sequence(first: v as UIResponder, next: { $0.next }).first { $0 is ChatPerfListVC } as? ChatPerfListVC }
            .reduce(into: [ChatPerfListVC]()) { list, vc in if !list.contains(where: { $0 === vc }) { list.append(vc) } }
            .filter { $0.viewIfLoaded?.window != nil }
    }

    private var sessionTables: [SessionTableController] {
        all(window).compactMap { v in sequence(first: v as UIResponder, next: { $0.next }).first { $0 is SessionTableController } as? SessionTableController }
            .reduce(into: [SessionTableController]()) { list, vc in if !list.contains(where: { $0 === vc }) { list.append(vc) } }
            .filter { $0.viewIfLoaded?.window != nil }
    }

    private var tabBarHidden: Bool {
        guard let tabs = all(window).lazy.compactMap({ v in sequence(first: v as UIResponder, next: { $0.next }).first { $0 is UITabBarController } as? UITabBarController }).first else { return true }
        if #available(iOS 26.0, *) { return tabs.isTabBarHidden }
        return tabs.tabBar.isHidden
    }

    private func mount(width: CGFloat, height: CGFloat) throws -> AppState {
        let fx = try fixtures.makeFixture(total: 40, onScreen: true)
        fx.vc.view.window?.isHidden = true
        fx.app.connectionStatus = .connected
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 2
        window.frame = CGRect(x: 0, y: 0, width: width, height: height)
        window.rootViewController = UIHostingController(rootView: MainTabView(allowsInitialNavigation: true).environment(fx.app))
        window.makeKeyAndVisible()
        drain(1500)
        return fx.app
    }

    private func resize(_ width: CGFloat, _ height: CGFloat) {
        window.frame = CGRect(x: 0, y: 0, width: width, height: height)
        drain(1200)
    }

    func testWideWindowShowsTheListBesideTheChatAndFoldingKeepsTheChat() throws {
        let app = try mount(width: 951, height: 669)
        XCTAssertEqual(sessionTables.count, 1, "the list is shown")
        XCTAssertFalse(marked("session-split-placeholder").isEmpty, "no Session selected: placeholder beside the list")
        XCTAssertTrue(chats.isEmpty)

        // Open from the list, as a tap on the row does.
        let table = try XCTUnwrap(sessionTables.first)
        let tableView = try XCTUnwrap(all(table.view).compactMap { $0 as? UITableView }.first)
        let row = try XCTUnwrap((0..<tableView.numberOfRows(inSection: 0)).first.map { IndexPath(row: $0, section: 0) })
        table.tableView(tableView, didSelectRowAt: row)
        drain(1500)
        let chat = try XCTUnwrap(chats.first, "the chat opened beside the list")
        XCTAssertEqual(chats.count, 1)
        XCTAssertEqual(sessionTables.count, 1, "the list stays visible")
        XCTAssertEqual(table.selectedSessionId, fixtures.sid)
        let cell = try XCTUnwrap(tableView.cellForRow(at: row))
        XCTAssertEqual(cell.backgroundColor, SessionTableController.rowBackground(selected: true), "selected row is highlighted")
        XCTAssertTrue(marked("chat-back-button").isEmpty, "no Back button beside the list")
        XCTAssertFalse(tabBarHidden, "tab bar stays: Devices and Settings remain reachable")
        let chatFrame = chat.view.convert(chat.view.bounds, to: window)
        XCTAssertGreaterThanOrEqual(chatFrame.minX, SessionSplitLayout.sidebarWidth, "chat is right of the list")

        // Fold: one column, the same chat stays open (no reload), with Back.
        resize(466, 678)
        XCTAssertTrue(chats.first === chat, "folding keeps the same chat")
        XCTAssertTrue(sessionTables.isEmpty, "the chat covers the list on a narrow window")
        XCTAssertFalse(marked("chat-back-button").isEmpty, "Back returns to the list")
        XCTAssertTrue(tabBarHidden, "narrow chat hides the tab bar, as before")

        // Unfold: the list comes back beside the same chat.
        resize(951, 669)
        XCTAssertTrue(chats.first === chat, "unfolding keeps the same chat")
        XCTAssertEqual(sessionTables.count, 1)
        XCTAssertEqual(sessionTables.first?.selectedSessionId, fixtures.sid)
        XCTAssertTrue(marked("chat-back-button").isEmpty)
        XCTAssertFalse(tabBarHidden, "unfolding brings the tab bar back")
        _ = app
    }

    func testNarrowWindowKeepsTheIPhoneLayout() throws {
        _ = try mount(width: 402, height: 874)
        XCTAssertEqual(sessionTables.count, 1)
        XCTAssertTrue(marked("session-split-placeholder").isEmpty, "no detail column on a phone")
        let table = try XCTUnwrap(sessionTables.first)
        let tableView = try XCTUnwrap(all(table.view).compactMap { $0 as? UITableView }.first)
        table.tableView(tableView, didSelectRowAt: IndexPath(row: 0, section: 0))
        drain(1500)
        XCTAssertEqual(chats.count, 1, "the chat is pushed")
        XCTAssertTrue(sessionTables.isEmpty, "over the list")
        XCTAssertFalse(marked("chat-back-button").isEmpty)
        XCTAssertNil(table.selectedSessionId, "no highlight in single-column layout")
    }
}

private extension UIView {
    var isHiddenOrHasHiddenAncestor: Bool {
        sequence(first: self, next: { $0.superview }).contains { $0.isHidden || $0.alpha < 0.01 }
    }
}
#endif
