#if os(iOS)
import XCTest
@testable import Kraki

/// Cold-launch routing of `IOSLaunchCoordinator.bootstrap`. The gate stays up
/// for a minimum time; a signed-out launch decides where to go after it.
@MainActor
final class IOSLaunchCoordinatorTests: XCTestCase {
    private func signedOutHost() -> AppState {
        let app = AppState.makeUnitTestHost()
        app.hasStoredCredentials = false
        return app
    }

    /// G1: a pairing link that opens the app cold pairs while the gate is
    /// still up. The launch must land signed in, not on "Welcome to Kraki".
    func testCredentialsGainedDuringTheMinimumGateWaitLandSignedIn() async throws {
        let app = signedOutHost()
        // A 1 s gate, so the sign-in at 100 ms is inside it on a loaded machine.
        let coordinator = IOSLaunchCoordinator(minimumVisibleSecondsOverride: 1,
                                               presentationWatchdogSecondsOverride: 30)
        let launch = Task { await coordinator.bootstrap(appState: app) }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(coordinator.phase, .launching)
        // What the pairing link's auth_ok does; RootView forwards the change,
        // which the coordinator ignores while it is still launching.
        app.hasStoredCredentials = true
        coordinator.reconcileAuthentication(hasStoredCredentials: true, connectionStatus: .connected)
        await launch.value

        XCTAssertEqual(coordinator.phase, .preparingAuthenticated)
        await coordinator.authenticatedSurfaceDidPresent()
        XCTAssertEqual(coordinator.phase, .authenticated)
        XCTAssertFalse(coordinator.isLaunchGateVisible)
    }

    /// Unchanged: a signed-out launch with no sign-in during the wait still
    /// shows the signed-out entry after the minimum gate time.
    func testSignedOutLaunchStillLandsSignedOutAfterTheMinimumGate() async {
        let app = signedOutHost()
        let coordinator = IOSLaunchCoordinator(minimumVisibleSecondsOverride: 0.2)
        let startedAt = Date()
        await coordinator.bootstrap(appState: app)

        XCTAssertEqual(coordinator.phase, .signedOut)
        XCTAssertFalse(coordinator.isLaunchGateVisible)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(startedAt), 0.19)
    }

    /// Unchanged: a returning user goes straight to preparing the Sessions
    /// shell under the gate, without waiting first.
    func testSignedInLaunchPreparesTheSessionsShellAtOnce() async {
        let app = AppState.makeUnitTestHost()
        XCTAssertTrue(app.hasStoredCredentials)
        let coordinator = IOSLaunchCoordinator(minimumVisibleSecondsOverride: 5,
                                               presentationWatchdogSecondsOverride: 30)
        let startedAt = Date()
        await coordinator.bootstrap(appState: app)

        XCTAssertEqual(coordinator.phase, .preparingAuthenticated)
        XCTAssertTrue(coordinator.isLaunchGateVisible)
        XCTAssertLessThan(Date().timeIntervalSince(startedAt), 1)
    }

    /// Unchanged: signing in after a signed-out launch, and signing out again.
    func testSignInAndSignOutAfterASignedOutLaunch() async {
        let app = signedOutHost()
        let coordinator = IOSLaunchCoordinator(minimumVisibleSecondsOverride: 0,
                                               presentationWatchdogSecondsOverride: 30)
        await coordinator.bootstrap(appState: app)
        XCTAssertEqual(coordinator.phase, .signedOut)

        coordinator.reconcileAuthentication(hasStoredCredentials: true, connectionStatus: .connected)
        XCTAssertEqual(coordinator.phase, .preparingAuthenticated)
        await coordinator.authenticatedSurfaceDidPresent()
        XCTAssertEqual(coordinator.phase, .authenticated)

        coordinator.reconcileAuthentication(hasStoredCredentials: false, connectionStatus: .awaitingLogin)
        XCTAssertEqual(coordinator.phase, .signedOut)
    }
}
#endif
