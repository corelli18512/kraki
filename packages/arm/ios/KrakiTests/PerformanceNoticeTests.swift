import XCTest
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
