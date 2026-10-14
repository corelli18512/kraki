import XCTest
import SwiftUI
#if os(iOS)
import UIKit
#endif
@testable import Kraki

@MainActor
final class PerformanceNoticeTests: XCTestCase {
    private var defaults: UserDefaults!
    private var declined = 0

    override func setUp() {
        defaults = UserDefaults(suiteName: "PerformanceNoticeTests-\(UUID().uuidString)")
        declined = 0
    }

    private func notice(pending: @escaping () -> Bool = { false }) -> PerformanceNotice {
        let n = PerformanceNotice()
        n.defaults = defaults
        n.settleDelay = .milliseconds(10)
        n.skipsAutomatedRuns = false
        n.permissionPending = { pending() }
        n.onDecline = { [unowned self] in declined += 1 }
        return n
    }

    private func wait(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }

    func testShowsOnceAfterSignInAndOKKeepsSharing() async {
        let n = notice()
        n.authenticated()
        n.authenticated() // reconnects do not schedule twice
        await wait(0.2)
        XCTAssertTrue(n.isVisible)
        n.choose(share: true)
        XCTAssertFalse(n.isVisible)
        XCTAssertTrue(n.hasBeenSeen)
        XCTAssertEqual(declined, 0)

        let later = notice() // next launch
        later.authenticated()
        await wait(0.2)
        XCTAssertFalse(later.isVisible, "seen once, never again")
    }

    func testDontShareTurnsSharingOff() async {
        let n = notice()
        n.authenticated()
        await wait(0.2)
        n.choose(share: false)
        XCTAssertEqual(declined, 1)
        XCTAssertTrue(n.hasBeenSeen)
    }

    func testAPermissionPromptLeftOpenDefersTheNoticeToTheNextSignIn() async {
        var pending = true
        let n = notice(pending: { pending })
        n.authenticated()
        await wait(62)
        XCTAssertFalse(n.isVisible, "never shown while the prompt is still open")
        pending = false
        n.authenticated() // next reconnect / foreground
        await wait(0.3)
        XCTAssertTrue(n.isVisible)
    }

    #if os(iOS)
    func testPhoneUsesCenteredModalAlertUntilAnExplicitChoice() async throws {
        try requireForegroundUITests()
        let n = notice()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView:
            Button("Background action") {}
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .modifier(PerformanceNoticePresentation(notice: n))
        )
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        await wait(0.1)
        n.showForTesting()
        let deadline = Date().addingTimeInterval(5)
        while host.presentedViewController == nil, Date() < deadline { await wait(0.05) }
        let alert = try XCTUnwrap(host.presentedViewController as? UIAlertController)
        XCTAssertEqual(alert.preferredStyle, .alert, "Centered modal, not a bottom action sheet or floating card")
        XCTAssertEqual(alert.title, PerformanceNoticeCopy.title)
        XCTAssertEqual(alert.actions.map(\.title), ["Don't Share", "OK"])
        XCTAssertTrue(alert.message?.contains(PerformanceNoticeCopy.settingsHint) == true)
        XCTAssertFalse(n.hasBeenSeen, "Showing the alert is not a choice")

        // The native presentation owns input and accessibility focus while
        // displayed; the original content stays underneath it, not alongside.
        XCTAssertTrue(host.presentedViewController === alert)
        n.choose(share: false)
        let dismissalDeadline = Date().addingTimeInterval(5)
        while host.presentedViewController != nil, Date() < dismissalDeadline { await wait(0.05) }
        XCTAssertNil(host.presentedViewController)
        XCTAssertTrue(n.hasBeenSeen)
        XCTAssertEqual(declined, 1)
    }
    #endif

    func testWaitsForTheNotificationPermissionAnswer() async {
        var pending = true
        let n = notice(pending: { pending })
        n.authenticated()
        await wait(1.3)
        XCTAssertFalse(n.isVisible, "never on top of the permission prompt")
        pending = false
        await wait(1.3)
        XCTAssertTrue(n.isVisible)
    }
}
