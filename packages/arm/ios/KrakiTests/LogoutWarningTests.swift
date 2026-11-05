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
        XCTAssertEqual(message, (AppState.logoutLossNotice(unsent: 2, drafts: 0, working: 1) + [generic]).joined(separator: "\n\n"))
        XCTAssertTrue(message.contains(String(localized: "\(2) messages haven't been delivered yet. Logging out discards them.")), message)
        XCTAssertTrue(message.contains(String(localized: "\(1) sessions are still working. They keep running on your computer.")), message)
        XCTAssertTrue(message.hasSuffix(generic))
    }

    /// A pending fork or a new session without a first message is not an
    /// unsent message.
    func testPendingForkOrEmptyNewSessionIsNotAnUnsentMessage() throws {
        let app = AppState.makeUnitTestHost()
        let sender = try XCTUnwrap(app.commandSender)
        sender.forkSession(sessionId: "s1")
        sender.createSession(targetDeviceId: "pc", model: "gpt")
        XCTAssertEqual(sender.unsentMessageCount, 0)
        XCTAssertEqual(app.logoutConfirmationMessage, String(localized: "You'll need to scan a pairing QR or sign in again to reconnect."))

        sender.createSession(targetDeviceId: "pc", model: "gpt", prompt: "first message")
        XCTAssertEqual(sender.unsentMessageCount, 1, "a first message waiting for its session counts")
    }

    /// Drafts go with the account's data, so the warning names them too;
    /// blank ones are not counted.
    func testLogoutAlertNamesUnsentDrafts() {
        let app = AppState.makeUnitTestHost()
        app.sessionStore.setDraft("s1", "half a thought")
        app.sessionStore.setDraft("s2", "  \n")
        XCTAssertEqual(app.unsentDraftCount, 1)
        XCTAssertEqual(app.logoutLossNotice, [String(localized: "\(1) drafts haven't been sent. Logging out discards them.")])
        XCTAssertTrue(app.logoutConfirmationMessage.hasPrefix(String(localized: "\(1) drafts haven't been sent. Logging out discards them.")))
    }

    /// "Log Out and Connect" discards the same things as Log Out, so its
    /// prompt says so (review G2).
    func testAlreadyConnectedPromptNamesWhatLoggingOutDiscards() throws {
        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?token=pt_other"))
        let prompt = PairingLinkPrompt.alreadyConnected(link, login: "octo")
        let base = String(localized: "This iPhone is already connected as \("octo"). To connect a different account, log out first.")
        XCTAssertEqual(PairingPromptAlerts.message(for: prompt), base)
        let loss = AppState.logoutLossNotice(unsent: 2, drafts: 1, working: 0)
        XCTAssertEqual(loss.count, 2)
        XCTAssertEqual(PairingPromptAlerts.message(for: prompt, logoutLoss: loss), ([base] + loss).joined(separator: "\n\n"))
    }

    func testRemovedDeviceErrorSaysUndeliveredMessagesWereDiscarded() {
        XCTAssertEqual(AuthManager.fatalAuthErrorText("Unknown device", discardedMessages: 0, discardedDrafts: 0), "Unknown device")
        let text = AuthManager.fatalAuthErrorText("Unknown device", discardedMessages: 3, discardedDrafts: 0)
        XCTAssertTrue(text.hasPrefix("Unknown device\n"), text)
        XCTAssertTrue(text.contains(String(localized: "\(3) undelivered messages were removed from this device with its sign-in.")), text)
    }

    /// K-308: a removed device's drafts are wiped too, and the error says so.
    func testRemovedDeviceErrorSaysDraftsWereDiscarded() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-k308-\(UUID())")
        let app = AppState(testDatabase: MessageDatabase(inMemory: ()))
        defer { app.disconnect(); try? FileManager.default.removeItem(at: root) }
        app.relayURL = "ws://127.0.0.1:9"
        app.setupNetworking(outboxURL: root.appendingPathComponent("outbox.json"))
        let auth = try XCTUnwrap(app.authManager)
        auth.debugIsolatedIdentity = true
        auth.debugSetStoredDeviceId("k308-device")
        #if os(macOS)
        AuthManager.debugCLICredentialLoader = { _ in nil }
        defer { AuthManager.debugCLICredentialLoader = nil }
        #endif
        app.sessionStore.setDraft("s1", "half a thought")

        auth.handleAuthError(message: ["code": "unknown_device", "message": "Unknown device"])

        XCTAssertFalse(app.hasStoredCredentials)
        XCTAssertTrue(app.sessionStore.drafts.isEmpty, "the removed device keeps no drafts")
        // The app's own copy, not the relay's English reason (K-076).
        XCTAssertEqual(app.lastError, String(localized: "Authentication failed. Please scan a new pairing QR code.") + "\n" + String(localized: "\(1) unsent drafts were removed from this device with its sign-in."))
    }
}
