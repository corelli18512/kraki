#if os(iOS)
import UserNotifications
import XCTest
@testable import Kraki

@MainActor
final class PushPermissionAndSignOutTests: XCTestCase {
    private var app: AppState!
    private var push: PushManager!
    private var saved: (enabled: Bool, whenAllowed: Bool, pendingUnregister: Any?)!
    private let pendingUnregisterKey = "kraki.pushPendingUnregister"

    override func setUp() async throws {
        app = AppState.makeUnitTestHost()
        push = PushManager(appState: app)
        saved = (push.userEnabled, push.enableWhenAllowed, UserDefaults.standard.object(forKey: pendingUnregisterKey))
    }

    override func tearDown() async throws {
        push.userEnabled = saved.enabled
        push.enableWhenAllowed = saved.whenAllowed
        UserDefaults.standard.set(saved.pendingUnregister, forKey: pendingUnregisterKey)
        push = nil
        app = nil
    }

    /// K-027: signing out retires the APNs token even when the relay is
    /// reachable — the unregister frame can be lost when sign-out closes the
    /// socket right after it, and the relay would keep pushing the old account.
    func testSignOutWhileConnectedAlsoUnregistersFromAPNs() {
        app.connectionStatus = .connected
        push.handleDeviceToken(Data([0x0A, 0x0B]))
        push.handleSignOut()
        XCTAssertEqual(push.apnsUnregistrationsForTesting, 1)
        XCTAssertNil(push.deviceToken)
    }

    func testSignOutOfflineUnregistersFromAPNs() {
        app.connectionStatus = .disconnected
        push.handleSignOut()
        XCTAssertEqual(push.apnsUnregistrationsForTesting, 1)
    }

    /// K-036: notifications the human asked for, refused by iOS, come on once
    /// iOS allows them (the "tap the gear to enable" path).
    func testNotificationsRequestedThenAllowedInIOSSettingsTurnOn() {
        push.userEnabled = false
        push.enableWhenAllowed = true // set when iOS refused `enable()`
        push.adoptSystemPermission(.denied)
        XCTAssertFalse(push.userEnabled, "still refused")
        push.adoptSystemPermission(.authorized)
        XCTAssertTrue(push.userEnabled)
        XCTAssertFalse(push.enableWhenAllowed)
    }

    /// Kraki's own toggle switched off stays off, whatever iOS allows.
    func testToggleSwitchedOffStaysOffWhenIOSAllows() {
        push.enableWhenAllowed = true
        push.disable()
        push.adoptSystemPermission(.authorized)
        XCTAssertFalse(push.userEnabled)
    }
}
#endif
