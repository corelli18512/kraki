import XCTest
import SwiftUI
import VoiceInputCore
@testable import Kraki

#if os(iOS)
/// The New Session sheet's composer: typed and dictated first messages, with
/// the synthetic voice engine (no network or microphone).
@MainActor
final class IOSNewSessionComposerTests: XCTestCase {
    private var app: AppState!
    private var driver: IOSVoiceHoldScenarioDriver!
    private let key = IOSVoiceComposer.newSessionDraftID
    private var inputs: [(session: String, text: String)] = []

    override func setUp() async throws {
        driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        inputs = []
        app.testOutboundMessageHandler = { [weak self] payload, _, _ in
            if payload["type"] as? String == "send_input" {
                self?.inputs.append((payload["sessionId"] as? String ?? "",
                                     (payload["payload"] as? [String: Any])?["text"] as? String ?? ""))
            }
            return true
        }
    }

    override func tearDown() async throws {
        app?.iosVoiceComposer.discard()
        app?.voiceInputController.forgetLease()
        app?.sessionStore.setDraft(key, "")
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private func startRecording() {
        app.iosVoiceComposer.begin(sessionID: key, selection: nil,
                                   context: VoiceSessionContextBuilder.buildNewSession(agent: "pi", model: "m", deviceName: "PC"))
        drain(200)
    }

    /// Like the Mac: ↑ while dictating opens the chat at once; the speech is the
    /// first bubble, corrected in place, and goes out once to the real Session.
    func testSendWhileDictatingCreatesAndCorrectsInTheChatBubble() throws {
        startRecording()
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: key))
        driver.emit(.partial("请把这个功能接入"))
        drain(100)

        XCTAssertTrue(NewSessionStart.withVoice(app, device: "voice-test-device", agent: "pi", model: "m",
                                                effort: nil, title: "Voice"))
        let sender = try XCTUnwrap(app.commandSender)
        let request = try XCTUnwrap(sender.pendingPlaceholderIds.keys.first)
        let placeholder = try XCTUnwrap(sender.pendingPlaceholderIds[request])
        XCTAssertEqual(app.sessionStore.navigateToSession, placeholder, "the chat opens before correction")
        XCTAssertEqual(sender.pendingInputs(placeholder).first?.payload["localState"]?.stringValue, "correcting")
        XCTAssertEqual(sender.pendingCreateTitles[request], "Voice")
        XCTAssertTrue(inputs.isEmpty, "nothing goes out before the Session exists")

        sender.resolveCreateRequest(request, sessionId: "voice-a")
        driver.emit(.final("请把这个功能接入 Kraki。", rawText: "请把这个功能接入"))
        drain(250)
        XCTAssertEqual(inputs.map(\.session), ["voice-a"])
        XCTAssertEqual(inputs.map(\.text), ["请把这个功能接入 Kraki。"])
        XCTAssertEqual(app.sessionStore.drafts[key] ?? "", "", "the new-session draft is not left with the speech")
    }

    func testNothingStartsWithoutDictation() {
        XCTAssertFalse(NewSessionStart.withVoice(app, device: "voice-test-device", agent: "pi", model: "m",
                                                 effort: nil, title: nil))
        XCTAssertTrue(app.commandSender?.pendingPlaceholderIds.isEmpty ?? false)
    }
}
#endif
