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

    @Observable final class Presence { var shown = true }

    struct SheetHost: View {
        let presence: Presence
        let app: AppState
        var body: some View {
            VStack {
                if presence.shown {
                    IOSNewSessionComposer(canStart: true,
                                          voiceContext: { VoiceSessionContextBuilder.buildNewSession(agent: "pi", model: "m", deviceName: "PC") },
                                          onSendText: { _ in }, onSendVoice: {})
                }
            }
            .environment(app)
        }
    }

    /// Swiping the New Session sheet away while dictating must stop the
    /// microphone (the speech stays as the new-session draft), as the chat
    /// composer and the Mac sheet do.
    func testClosingTheSheetWhileDictatingStopsRecording() throws {
        let presence = Presence()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(rootView: SheetHost(presence: presence, app: app))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        drain(300)
        startRecording()
        driver.emit(.partial("帮我看看"))
        drain(100)
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: key))

        presence.shown = false
        drain(400)
        XCTAssertFalse(app.iosVoiceComposer.isRecording(in: key), "the microphone stops with the sheet")
    }

    /// A typed first message whose create fails goes back to the new-session
    /// draft (the voice path already did), so the user can retry it.
    func testTypedPromptReturnsToTheDraftWhenCreateFails() throws {
        let sender = try XCTUnwrap(app.commandSender)
        let request = sender.createSession(targetDeviceId: "voice-test-device", agentId: "pi", model: "m", prompt: "修一下登录")
        sender.failPendingRequest(request, reason: "Unknown model")
        XCTAssertEqual(app.sessionStore.drafts[key], "修一下登录")
        XCTAssertTrue(inputs.isEmpty)
    }

    /// A timed-out create returns the typed message to the new-session draft.
    /// If the computer creates the Session after all, the message moves to
    /// that Session's draft (not sent, not left in both places).
    func testTypedPromptReturnsToTheDraftWhenCreateTimesOut() throws {
        let sender = try XCTUnwrap(app.commandSender)
        let request = sender.createSession(targetDeviceId: "voice-test-device", agentId: "pi", model: "m", prompt: "修一下登录")
        sender.expirePendingRequest(request)
        XCTAssertEqual(app.sessionStore.drafts[key], "修一下登录")

        sender.resolveCreateRequest(request, sessionId: "late")
        XCTAssertEqual(app.sessionStore.drafts["late"], "修一下登录")
        XCTAssertEqual(app.sessionStore.drafts[key] ?? "", "")
        XCTAssertTrue(inputs.isEmpty, "a late Session does not send the message")
    }

    /// After a timeout the user retried, then the first Session arrived late:
    /// the retry's text in the composer is not touched.
    func testLateCreateLeavesAnEditedDraftAlone() throws {
        let sender = try XCTUnwrap(app.commandSender)
        let request = sender.createSession(targetDeviceId: "voice-test-device", agentId: "pi", model: "m", prompt: "修一下登录")
        sender.expirePendingRequest(request)
        app.sessionStore.setDraft(key, "修一下登录，顺便看看注册")
        sender.resolveCreateRequest(request, sessionId: "late")
        XCTAssertEqual(app.sessionStore.drafts[key], "修一下登录，顺便看看注册")
        XCTAssertEqual(app.sessionStore.drafts["late"], "修一下登录")
    }

    func testNothingStartsWithoutDictation() {
        XCTAssertFalse(NewSessionStart.withVoice(app, device: "voice-test-device", agent: "pi", model: "m",
                                                 effort: nil, title: nil))
        XCTAssertTrue(app.commandSender?.pendingPlaceholderIds.isEmpty ?? false)
    }
}
#endif
