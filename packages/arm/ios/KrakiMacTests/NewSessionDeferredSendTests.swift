#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Review group 2 (2026-10-13): when the Mac new-session composer may start a
/// Session. Synthetic speech, an offscreen window, no microphone or network.
@MainActor
final class NewSessionDeferredSendTests: XCTestCase {
    private var window: NSWindow!
    private var app: AppState!
    private var driver: IOSVoiceHoldScenarioDriver!
    private var savedLast: String?
    private let key = IOSVoiceComposer.newSessionDraftID
    private let device = "voice-test-device"

    override func setUp() async throws {
        if ProcessInfo.processInfo.environment["KRAKI_NEW_SESSION_VOICE_SHOTS"] != "1" { try requireForegroundUITests() }
        savedLast = SessionPrefs.lastDeviceId()
        SessionPrefs.saveLastDevice(device)
        driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        app.deviceStore.setDeviceAgents(device, agents: [
            AgentCapabilities(type: "code", id: "pi", models: ["m"], modelDetails: nil)
        ])
        let view = MacStartSessionView(firstTime: false)
            .environment(app).environment(TentacleCLIManager())
        window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 820, height: 420), styleMask: [.borderless],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        drain(600)
    }

    override func tearDown() async throws {
        app?.iosVoiceComposer.discard()
        app?.voiceInputController.forgetLease()
        window?.orderOut(nil); window?.contentView = nil; window = nil
        if let savedLast { SessionPrefs.saveLastDevice(savedLast) }
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }
    private var draft: String { app.sessionStore.drafts[key] ?? "" }
    private var createdPrompts: [String] { Array(app.commandSender?.pendingCreateRequests.values ?? [:].values) }

    /// A real click at the control's probe; `settle` ms of run loop afterwards.
    private func press(_ id: String, settle: Int = 300) throws {
        let root = try XCTUnwrap(window.contentView)
        let marker = try XCTUnwrap(views(root).first { $0.identifier?.rawValue == id }, "missing control \(id)")
        let frame = marker.convert(marker.bounds, to: nil)
        let point = CGPoint(x: frame.midX, y: frame.midY)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        drain(settle)
    }

    /// Creation is immediate, but recognition failure must never send partial
    /// text to the agent. Recover it in the destination chat's draft.
    func testFailedRecognitionReturnsTextToDestinationChat() throws {
        try press("mac.newSession.voice")
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: key))
        let heard = app.iosVoiceComposer.rawText
        XCTAssertFalse(heard.isEmpty)
        try press("mac.newSession.create")
        let sender = try XCTUnwrap(app.commandSender)
        let request = try XCTUnwrap(sender.pendingPlaceholderIds.keys.first)
        let placeholder = try XCTUnwrap(sender.pendingPlaceholderIds[request])
        driver.emit(.failed("gateway error: Doubao ASR error 45000081: wait packet timeout"))
        drain(300)
        XCTAssertEqual(createdPrompts, [""], "create never contains raw speech")
        XCTAssertEqual(app.sessionStore.drafts[placeholder], heard)
        sender.resolveCreateRequest(request, sessionId: "voice-a")
        XCTAssertEqual(app.sessionStore.drafts["voice-a"], heard)
        XCTAssertTrue(sender.pendingInputs("voice-a").isEmpty)
        XCTAssertTrue(app.voiceInputController.hasFailure(for: "voice-a"))
    }

    /// 2-16 (b): ↑ before the mic started ends the utterance synchronously;
    /// the send button must not stay waiting forever.
    func testSendBeforeMicStartsDoesNotLeaveTheSendWaiting() throws {
        app.sessionStore.setDraft(key, "Typed first")
        drain(150)
        try press("mac.newSession.voice", settle: 0)
        try press("mac.newSession.create", settle: 300)
        XCTAssertNil(app.iosVoiceComposer.operation)
        XCTAssertEqual(draft, "")
        let placeholder = try XCTUnwrap(app.commandSender?.pendingPlaceholderIds.values.first)
        XCTAssertEqual(app.sessionStore.navigateToSession, placeholder)
        XCTAssertEqual(app.commandSender?.pendingInputs(placeholder).first?.content, "Typed first")
    }

    func testCreationFailureRestoresSpeechAndFencesLateCorrection() throws {
        try press("mac.newSession.voice")
        let heard = app.iosVoiceComposer.rawText
        try press("mac.newSession.create")
        let sender = try XCTUnwrap(app.commandSender)
        let request = try XCTUnwrap(sender.pendingPlaceholderIds.keys.first)
        let placeholder = try XCTUnwrap(sender.pendingPlaceholderIds[request])
        sender.failPendingRequest(request, reason: "Computer disconnected")
        XCTAssertEqual(draft, heard)
        XCTAssertNil(app.iosVoiceComposer.operation)
        XCTAssertTrue(sender.pendingInputs(placeholder).isEmpty)
        driver.emit(.final("Late correction", rawText: heard))
        sender.resolveCreateRequest(request, sessionId: "voice-a")
        drain(100)
        XCTAssertEqual(draft, heard)
        XCTAssertTrue(sender.pendingInputs("voice-a").isEmpty)
    }

    /// 2-40: an offline computer with cached agents is not a place to start a
    /// Session: Return keeps the prompt.
    func testOfflineComputerWithCachedAgentsDoesNotAcceptTheSend() throws {
        app.deviceStore.setDeviceOnline(device, online: false)
        app.sessionStore.setDraft(key, "Start here")
        drain(300)
        try press("mac.newSession.create")
        XCTAssertTrue(createdPrompts.isEmpty)
        XCTAssertEqual(draft, "Start here")
    }
}
#endif
