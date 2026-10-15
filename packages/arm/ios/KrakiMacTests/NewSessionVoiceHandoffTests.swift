#if os(macOS)
import XCTest
@testable import Kraki_Dev

@MainActor
final class NewSessionVoiceHandoffTests: XCTestCase {
    private var app: AppState!
    private var inputs: [(session: String, text: String)] = []

    override func setUp() {
        app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        app.testOutboundMessageHandler = { [weak self] payload, _, _ in
            if payload["type"] as? String == "send_input" {
                self?.inputs.append((payload["sessionId"] as? String ?? "",
                    (payload["payload"] as? [String: Any])?["text"] as? String ?? ""))
            }
            return true
        }
    }

    override func tearDown() {
        app.iosVoiceComposer.discard()
        app.voiceInputController.forgetLease()
        app = nil
        inputs = []
    }

    private func staged() throws -> (CommandSender, String, String, String) {
        let sender = try XCTUnwrap(app.commandSender)
        let request = sender.createSession(targetDeviceId: "voice-test-device", agentId: "pi", model: "m", voice: true)
        let placeholder = try XCTUnwrap(sender.pendingPlaceholderIds[request])
        let client = try XCTUnwrap(sender.stageInput(sessionId: placeholder, text: "Original speech"))
        return (sender, request, placeholder, client)
    }

    func testLeavingPlaceholderDoesNotPermitSendingToItsLocalID() throws {
        let (sender, request, placeholder, client) = try staged()
        app.sessionStore.removePendingSession(placeholder)
        XCTAssertTrue(sender.dispatchStagedInput(sessionId: placeholder, clientId: client, text: "Corrected speech"))
        sender.resendPendingInputs(reason: "test_reconnect")
        XCTAssertTrue(inputs.isEmpty)
        sender.resolveCreateRequest(request, sessionId: "voice-a")
        XCTAssertEqual(inputs.map(\.session), ["voice-a"])
        XCTAssertEqual(inputs.map(\.text), ["Corrected speech"])
    }

    func testCreateTimeoutCleanupRecoversOriginalAndFollowupWithoutLateSend() throws {
        let (sender, request, placeholder, client) = try staged()
        sender.updateStagedInput(sessionId: placeholder, clientId: client, text: "Half corrected", original: "Original plus tail")
        app.sessionStore.setDraft(placeholder, "Follow-up")
        sender.clearPendingRequest(request) // the create timeout's cleanup
        XCTAssertEqual(app.sessionStore.drafts[IOSVoiceComposer.newSessionDraftID], "Original plus tail\nFollow-up")
        XCTAssertTrue(sender.pendingInputs(placeholder).isEmpty)
        XCTAssertFalse(sender.dispatchStagedInput(sessionId: placeholder, clientId: client, text: "Late final"))
        sender.resolveCreateRequest(request, sessionId: "voice-a")
        XCTAssertTrue(inputs.isEmpty)
    }

    func testDeletedBubbleDoesNotReappearWhenCreationResolves() throws {
        let (sender, request, placeholder, client) = try staged()
        sender.discardPending(sessionId: placeholder, clientId: client)
        sender.resolveCreateRequest(request, sessionId: "voice-a")
        XCTAssertFalse(sender.dispatchStagedInput(sessionId: "voice-a", clientId: client, text: "Late final"))
        XCTAssertTrue(sender.pendingInputs("voice-a").isEmpty)
        XCTAssertTrue(inputs.isEmpty)
    }

    func testRelaunchRecoversOrphanedPlaceholderTextAndNeverRetriesItsID() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-handoff-\(UUID()).json")
        let stored: [[String: Any]] = [
            ["sessionId": "pending-second-creation", "clientId": "voice-2", "order": 2,
             "text": "Second utterance", "state": "sending"],
            ["sessionId": "pending-before-creation", "clientId": "voice-1", "order": 1,
             "text": "Heard before quitting", "state": "correcting"]
        ]
        try JSONSerialization.data(withJSONObject: stored).write(to: url)
        let restored = CommandSender(appState: app, outboxURL: url)
        XCTAssertEqual(app.sessionStore.drafts[IOSVoiceComposer.newSessionDraftID], "Heard before quitting\nSecond utterance")
        XCTAssertTrue(restored.outbox.isEmpty)
        restored.resendPendingInputs(reason: "test_relaunch")
        XCTAssertTrue(inputs.isEmpty)
        await restored.waitForOutboxWritesForTesting()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "the recovered entry cannot reappear on another launch")
    }
}
#endif
