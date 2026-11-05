#if os(iOS)
import XCTest
@testable import Kraki

/// K-035: signed out with the relay unreachable, the login screen keeps
/// "Scan QR Code", and a pairing that gets no answer ends in an error.
@MainActor
final class LoginPairingTests: XCTestCase {
    override func tearDown() async throws {
        AppState.pairingTimeout = 30
    }

    func testBackgroundConnectKeepsTheLoginActions() {
        XCTAssertFalse(LoginView.showsStatusPanel(oauthInFlight: false, pairingInFlight: false, status: .connecting),
                       "only fetching sign-in options: Scan QR Code stays")
        XCTAssertTrue(LoginView.showsStatusPanel(oauthInFlight: false, pairingInFlight: true, status: .connecting))
        XCTAssertTrue(LoginView.showsStatusPanel(oauthInFlight: true, pairingInFlight: false, status: .awaitingLogin))
        XCTAssertTrue(LoginView.showsStatusPanel(oauthInFlight: false, pairingInFlight: false, status: .authenticating))
        XCTAssertFalse(LoginView.showsStatusPanel(oauthInFlight: false, pairingInFlight: false, status: .awaitingLogin))
    }

    private func signedOutApp() -> AppState {
        let app = AppState.makeUnitTestHost()
        app.hasStoredCredentials = false
        app.hasCompletedInitialConnect = false
        app.connectionStatus = .awaitingLogin
        return app
    }

    func testUnansweredPairingTimesOutWithAnError() throws {
        AppState.pairingTimeout = 0.2
        let app = signedOutApp()
        app.openPairingLink(try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?token=pt_1")))
        XCTAssertNotNil(app.pairingInFlightSince)
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        XCTAssertNil(app.pairingInFlightSince)
        XCTAssertEqual(app.connectionStatus, .awaitingLogin)
        XCTAssertEqual(app.lastError, String(localized: "Couldn't reach the relay to pair. Check your connection, then scan the code again."))
    }

    func testCancelStopsWaitingWithoutAnError() throws {
        let app = signedOutApp()
        app.openPairingLink(try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?token=pt_2")))
        app.cancelPairing()
        XCTAssertNil(app.pairingInFlightSince)
        XCTAssertEqual(app.connectionStatus, .awaitingLogin)
        XCTAssertNil(app.lastError)
    }

    func testAnsweredPairingDoesNotTimeOut() throws {
        AppState.pairingTimeout = 0.2
        let app = signedOutApp()
        app.openPairingLink(try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?token=pt_3")))
        app.onAuthFailed(error: "Invalid or expired pairing token")
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        XCTAssertEqual(app.lastError, "Invalid or expired pairing token", "the relay's answer stays")
    }
}
#endif
