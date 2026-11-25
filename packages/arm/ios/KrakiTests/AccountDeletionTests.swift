import XCTest
@testable import Kraki

@MainActor
final class AccountDeletionTests: XCTestCase {
    private func route(_ app: AppState, _ json: [String: Any]) throws {
        app.messageRouter?.handleRawMessage(try JSONSerialization.data(withJSONObject: json))
    }

    func testRequestWhileOfflineFailsWithoutSending() {
        let app = AppState.makeUnitTestHost()
        app.connectionStatus = .disconnected
        app.requestAccountDeletion()
        guard case .failed = app.accountDeletion else {
            return XCTFail("expected failure, got \(app.accountDeletion)")
        }
    }

    func testAccountDeletedSignsOutAndShowsNotice() throws {
        let app = AppState.makeUnitTestHost()
        app.user = UserInfo(id: "u1", login: "octo", provider: "github")
        app.deviceId = "app_1"
        app.connectionStatus = .connected
        app.accountDeletion = .deleting

        try route(app, ["type": "account_deleted"])

        XCTAssertNil(app.user)
        XCTAssertNil(app.deviceId)
        XCTAssertEqual(app.connectionStatus, .awaitingLogin)
        XCTAssertEqual(app.accountDeletion, .idle)
        XCTAssertTrue(app.accountDeletedNotice)
    }

    func testServerErrorDuringDeletionIsItsAnswer() throws {
        let app = AppState.makeUnitTestHost()
        app.accountDeletion = .deleting
        try route(app, ["type": "server_error", "message": "Could not delete the account. Try again."])
        XCTAssertEqual(app.accountDeletion, .failed("Could not delete the account. Try again."))
        XCTAssertNil(app.lastError)

        // Not deleting: a server error is the usual banner, in the app's
        // own words, never the relay's raw English (U8).
        app.accountDeletion = .idle
        try route(app, ["type": "server_error", "message": "Other"])
        XCTAssertEqual(app.lastError, String(localized: "The server couldn't complete that. Try again."))
        try route(app, ["type": "server_error", "message": "Could not remove the device. Try again later."])
        XCTAssertEqual(app.lastError, String(localized: "Couldn't remove the device. Try again later."))
    }

    /// U8: a refused live-session subscription is not a signed-in toast.
    func testSessionSubscriptionErrorIsNotShownAsAToast() {
        let app = AppState.makeUnitTestHost()
        app.reportSessionSubscriptionError("Cannot set live session subscription: target is unavailable.")
        XCTAssertNil(app.lastError)
    }
}
