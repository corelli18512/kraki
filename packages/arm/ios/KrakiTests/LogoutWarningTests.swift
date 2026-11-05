import XCTest
@testable import Kraki

/// Signing out (K-037) or being removed from the account (K-308) discards
/// what this device has not delivered yet; the user is told, not surprised.
@MainActor
final class LogoutWarningTests: XCTestCase {
    func testLogoutAlertNamesUnsentMessagesAndWorkingSessions() throws {
        let app = AppState.makeUnitTestHost()
        let generic = String(localized: "You'll need to scan a pairing QR or sign in again to reconnect.")
        XCTAssertEqual(app.logoutConfirmationMessage, generic, "nothing pending: the usual text")

        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: "s1", text: "queued one"))
        XCTAssertTrue(sender.sendInput(sessionId: "s2", text: "queued two"))
        XCTAssertEqual(sender.unsentMessageCount, 2)
        let digest = try XCTUnwrap(SessionDigest(json: ["id": "s3", "agent": "copilot", "title": "busy", "state": "active"]))
        app.sessionStore.upsertSession(digest, deviceId: "pc", deviceName: "PC")

        let message = app.logoutConfirmationMessage
        XCTAssertEqual(message, AppState.logoutConfirmationMessage(unsent: 2, working: 1))
        XCTAssertTrue(message.contains(String(localized: "\(2) messages haven't been delivered yet. Logging out discards them.")), message)
        XCTAssertTrue(message.contains(String(localized: "\(1) sessions are still working. They keep running on your computer.")), message)
        XCTAssertTrue(message.hasSuffix(generic))
    }

    func testRemovedDeviceErrorSaysUndeliveredMessagesWereDiscarded() {
        XCTAssertEqual(AuthManager.fatalAuthErrorText("Unknown device", discardedMessages: 0), "Unknown device")
        let text = AuthManager.fatalAuthErrorText("Unknown device", discardedMessages: 3)
        XCTAssertTrue(text.hasPrefix("Unknown device\n"), text)
        XCTAssertTrue(text.contains(String(localized: "\(3) undelivered messages were removed from this device with its sign-in.")), text)
    }
}
