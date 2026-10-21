#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// 2-13 (review group 2b): with the computer offline the iPhone composer stays
/// mounted like the Mac one. It used to unmount, which dropped an attached
/// photo (view state) and ended dictation (`onDisappear` → `depart`).
@MainActor final class OfflineComposerTests: XCTestCase {
    private let sid = "voice-a"
    private let device = "voice-test-device"

    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    private func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
    private func editor(_ host: UIViewController) -> UITextView? {
        all(host.view).compactMap { $0 as? UITextView }.first(where: \.isEditable)
    }

    private func setOnline(_ app: AppState, _ online: Bool) {
        app.deviceStore.devices[device]?.online = online
        drain(1.0) // SwiftUI applies the presence change within a few frames
    }

    private var window: UIWindow?
    private var app: AppState?

    override func tearDown() {
        app?.iosVoiceComposer.retireKeepingDraft(); app?.voiceInputController.forgetLease()
        window?.isHidden = true; window?.rootViewController = nil
        window = nil; app = nil
        super.tearDown()
    }

    private func host(_ app: AppState) throws -> (UIWindow, UIViewController) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: ChatView(sessionId: sid).environment(app))
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window; self.app = app
        drain(0.6)
        return (window, host)
    }

    func testComposerStaysMountedThroughAPresenceBlip() throws {
        try requireForegroundUITests()
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        setOnline(app, false)
        let (_, host) = try host(app)
        let field = try XCTUnwrap(editor(host), "the composer is shown while the computer is offline")

        setOnline(app, true)
        setOnline(app, false)
        setOnline(app, true)
        XCTAssertTrue(editor(host) === field, "the same composer view (and its attached photo) survives the blip")
    }

    func testDictationSurvivesThePresenceBlip() throws {
        try requireForegroundUITests()
        let driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        _ = try host(app)
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        let deadline = Date().addingTimeInterval(2)
        while !app.iosVoiceComposer.isRecording(in: sid), Date() < deadline { drain(0.02) }
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: sid))

        setOnline(app, false)
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: sid), "going offline must not end dictation")
        setOnline(app, true)
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: sid), "a presence blip must not end dictation")
    }

    func testQuestionReturnWaitsForStagedVoiceSend() throws {
        try assertStructuredReturnWaitsForVoice(answering: true)
    }

    func testPermissionReturnWaitsForStagedVoiceSend() throws {
        try assertStructuredReturnWaitsForVoice(answering: false)
    }

    private func assertStructuredReturnWaitsForVoice(answering: Bool) throws {
        try requireForegroundUITests()
        let driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false, automaticPartials: false)
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        var sent: [String] = []
        app.testOutboundMessageHandler = { message, _, _ in
            sent.append(message["type"] as? String ?? "")
            return true
        }
        self.app = app
        let voice = app.iosVoiceComposer
        voice.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        let deadline = Date().addingTimeInterval(2)
        while !voice.isRecording(in: sid), Date() < deadline { drain(0.02) }
        XCTAssertTrue(voice.isRecording(in: sid))
        driver.emit(.partial("voice first"))
        drain(0.1)
        XCTAssertTrue(voice.send(attachments: nil, delivery: .prompt))

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: MessageInputView(
            sessionId: sid,
            pendingPermission: answering ? nil : PendingPermission(id: "p", sessionId: sid, description: "Run?", toolName: "Bash", args: nil, timestamp: Date()),
            pendingQuestion: answering ? PendingQuestion(id: "q", sessionId: sid, question: "Which?", choices: nil, timestamp: Date()) : nil
        ).environment(app))
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        drain(0.3)
        let field = try XCTUnwrap(editor(host))
        field.becomeFirstResponder()
        field.insertText("typed second")
        drain(0.1)
        field.insertText("\n")
        drain(0.1)
        XCTAssertTrue(sent.isEmpty, "a keyboard structured response cannot overtake correcting voice")
        XCTAssertEqual(app.sessionStore.drafts[sid], "typed second", "blocked submission retains the draft")

        driver.emit(.final("voice first corrected", rawText: "voice first"))
        drain(0.2)
        XCTAssertEqual(sent, ["send_input"])
        field.insertText("\n")
        drain(0.2)
        XCTAssertEqual(sent, ["send_input", answering ? "send_input" : "deny"])
        XCTAssertEqual(app.sessionStore.drafts[sid] ?? "", "")
    }

    func testOfflineSendGoesToTheOutbox() throws {
        try requireForegroundUITests()
        let driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        setOnline(app, false)
        let (_, host) = try host(app)
        let field = try XCTUnwrap(editor(host))
        field.becomeFirstResponder()
        field.insertText("Queued while offline")
        drain(0.2)
        field.insertText("\n") // the return key sends
        drain(0.3)
        XCTAssertEqual(driver.lastSent, "Queued while offline")
        XCTAssertEqual(app.sessionStore.drafts[sid] ?? "", "")
    }
}
#endif
