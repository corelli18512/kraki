import XCTest
@testable import Kraki_Dev

/// The end of a Mac launch that found no credentials:
/// `MacLaunchCoordinator.finishLaunchWithoutAuthenticatedRoot`. Called directly,
/// so no daemon, login item or CLI login is touched.
@MainActor
final class MacLaunchCoordinatorTests: XCTestCase {
    private func makeHost(hasStoredCredentials: Bool) throws -> AppState {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.hasStoredCredentials = hasStoredCredentials
        return app
    }

    /// Same race as iOS G1: a sign-in that finishes during the minimum gate
    /// wait must not be dropped (reconcileAuthentication ignores it while
    /// launching), or the window stays on the signed-out page.
    func testSignInDuringTheMinimumGateWaitLandsSignedIn() async throws {
        let app = try makeHost(hasStoredCredentials: false)
        // A 1 s gate, so the sign-in at 100 ms is inside it on a loaded machine.
        let coordinator = MacLaunchCoordinator(minimumVisibleSecondsOverride: 1)
        let finish = Task { await coordinator.finishLaunchWithoutAuthenticatedRoot(appState: app,
                                                                                   ownerChoicePending: { false }) }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(coordinator.phase, .launching)
        app.hasStoredCredentials = true
        coordinator.reconcileAuthentication(hasStoredCredentials: true, connectionStatus: .connected)
        await finish.value

        XCTAssertEqual(coordinator.phase, .preparingAuthenticated)
        await coordinator.authenticatedSurfaceDidPresent()
        XCTAssertEqual(coordinator.phase, .authenticated)
    }

    /// Unchanged: no sign-in during the wait lands signed out.
    func testNoSignInDuringTheWaitLandsSignedOut() async throws {
        let app = try makeHost(hasStoredCredentials: false)
        let coordinator = MacLaunchCoordinator()
        await coordinator.finishLaunchWithoutAuthenticatedRoot(appState: app, ownerChoicePending: { false })
        XCTAssertEqual(coordinator.phase, .signedOut)
    }

    /// Unchanged: credentials that were already there when launch chose the
    /// signed-out page (forced signed-out launch) keep it signed out.
    func testCredentialsPresentBeforeTheWaitStaySignedOut() async throws {
        let app = try makeHost(hasStoredCredentials: true)
        let coordinator = MacLaunchCoordinator()
        await coordinator.finishLaunchWithoutAuthenticatedRoot(appState: app, ownerChoicePending: { false })
        XCTAssertEqual(coordinator.phase, .signedOut)
    }

    /// Unchanged: while setup asks which install runs Kraki, a sign-in does
    /// not skip that question (reconcileAuthentication waits for it too).
    func testSignInDuringTheWaitWaitsForAPendingOwnerChoice() async throws {
        let app = try makeHost(hasStoredCredentials: false)
        let coordinator = MacLaunchCoordinator(minimumVisibleSecondsOverride: 1)
        let finish = Task { await coordinator.finishLaunchWithoutAuthenticatedRoot(appState: app,
                                                                                   ownerChoicePending: { true }) }
        try await Task.sleep(for: .milliseconds(100))
        app.hasStoredCredentials = true
        await finish.value
        XCTAssertEqual(coordinator.phase, .signedOut)
    }
}
