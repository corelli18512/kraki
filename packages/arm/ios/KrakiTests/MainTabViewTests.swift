import XCTest
import SwiftUI
@testable import Kraki

#if os(iOS)
/// The root tab bar: the pre-iOS 26 New Session entry and the unread badge.
@MainActor
final class MainTabViewTests: XCTestCase {
    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    private func tabBarController(in view: UIViewController?) -> UITabBarController? {
        guard let view else { return nil }
        if let tabs = view as? UITabBarController { return tabs }
        for child in view.children { if let tabs = tabBarController(in: child) { return tabs } }
        return nil
    }

    /// K-319: iOS 18 (the deployment target) uses the legacy tab bar, which
    /// had no way to start a Session. It now has a trailing "New Session" tab
    /// that opens the sheet and is never selected.
    func testLegacyTabBarHasANewSessionAction() throws {
        let app = AppState.makeUnitTestHost()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(
            rootView: MainTabView(allowsInitialNavigation: false, forcesLegacyTabs: true).environment(app))
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        // Wait for the real condition: the + tab's interceptor is installed once the
        // tab screen appears, which a loaded iOS 27 CI simulator can take > 1 s to do.
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline,
              !(tabBarController(in: window.rootViewController)?.delegate is TabActionInterceptor.DelegateProxy) {
            drain(0.05)
        }

        let tabs = try XCTUnwrap(tabBarController(in: window.rootViewController))
        XCTAssertTrue(tabs.delegate is TabActionInterceptor.DelegateProxy, "the + tab interceptor is installed")
        let titles = tabs.tabBar.items?.map { $0.title ?? "" } ?? []
        XCTAssertEqual(titles.last, "New Session", "tabs: \(titles)")
        let selectedBefore = tabs.selectedIndex
        let delegate = try XCTUnwrap(tabs.delegate)
        let plus: Bool
        if !tabs.tabs.isEmpty, let tab = tabs.tabs.last {
            plus = delegate.tabBarController?(tabs, shouldSelectTab: tab) ?? true
        } else {
            let controller = try XCTUnwrap(tabs.viewControllers?.last)
            plus = delegate.tabBarController?(tabs, shouldSelect: controller) ?? true
        }
        XCTAssertFalse(plus, "the + tab is an action, never selected")
        drain(1)
        XCTAssertEqual(tabs.selectedIndex, selectedBefore)
        XCTAssertTrue(tabs.presentedViewController != nil || window.rootViewController?.presentedViewController != nil,
                      "the New Session sheet opens")
    }

    /// K-344: the Sessions tab badge is capped at "99+" and hidden at zero.
    func testUnreadBadgeIsCapped() {
        XCTAssertNil(MainTabView.unreadBadge(0))
        XCTAssertEqual(MainTabView.unreadBadge(1), "1")
        XCTAssertEqual(MainTabView.unreadBadge(99), "99")
        XCTAssertEqual(MainTabView.unreadBadge(100), "99+")
        XCTAssertEqual(MainTabView.unreadBadge(448), "99+")
    }
}
#endif
