#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// The new-session composer dictates like the chat Composer: same recording
/// surface, same progressive correction in the editor, and ↑ while recording
/// starts the Session only with the corrected text. Synthetic speech, an
/// offscreen window (never takes focus), no microphone or network.
@MainActor
final class NewSessionVoiceTests: XCTestCase {
    private var window: NSWindow!
    private var app: AppState!
    private var driver: IOSVoiceHoldScenarioDriver!
    private var savedLast: String?
    private let key = IOSVoiceComposer.newSessionDraftID
    private let raw = "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki \u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}"
    private let corrected = "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki\u{FF0C}\u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}\u{3002}"

    override func setUp() async throws {
        // Real (borderless, far off-screen) window + synthetic voice: CI, or
        // locally for screenshots with TEST_RUNNER_KRAKI_NEW_SESSION_VOICE_SHOTS=1
        // (the headless test host never shows or activates anything).
        if ProcessInfo.processInfo.environment["KRAKI_NEW_SESSION_VOICE_SHOTS"] != "1" {
            try requireForegroundUITests()
        }
        savedLast = SessionPrefs.lastDeviceId()
        SessionPrefs.saveLastDevice("voice-test-device")
        driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        app.deviceStore.setDeviceAgents("voice-test-device", agents: [
            AgentCapabilities(type: "code", id: "pi", models: ["m"], modelDetails: nil)
        ])
        let view = MacStartSessionView(firstTime: false)
            .environment(app).environment(TentacleCLIManager())
            .background(Color.surfacePrimary)
        window = KeyableWindow(contentRect: NSRect(x: -4000, y: -4000, width: 820, height: 420), styleMask: [.borderless],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        window.makeKey() // key within this (inactive) test app only; never activates it
        drain(600)
    }

    override func tearDown() async throws {
        app?.iosVoiceComposer.discard()
        app?.voiceInputController.forgetLease()
        window?.orderOut(nil); window?.contentView = nil; window = nil
        if let savedLast { SessionPrefs.saveLastDevice(savedLast) }
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private final class KeyableWindow: NSWindow {
        override var canBecomeKey: Bool { true }
    }

    /// Real clicks through the window's hit testing, at the control's probe.
    private func press(_ id: String) throws {
        let marker = try XCTUnwrap(views(window.contentView!).first { $0.identifier?.rawValue == id }, "missing control \(id)")
        let frame = marker.convert(marker.bounds, to: nil)
        let point = CGPoint(x: frame.midX, y: frame.midY)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        drain(300)
    }

    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }
    private var editor: NSTextView? { views(window.contentView!).compactMap { $0 as? NSTextView }.first(where: \.isEditable) }
    private var draft: String { app.sessionStore.drafts[key] ?? "" }
    private var createdPrompts: [String] { Array(app.commandSender?.pendingCreateRequests.values ?? [:].values) }

    private func capture(_ name: String) throws {
        for (suffix, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            drain(120)
            let view = try XCTUnwrap(window.contentView)
            view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["KRAKI_SNAPSHOT_DIR"] ?? "/tmp/kraki-new-session-voice")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: dir.appendingPathComponent("new-session-voice-\(name)-\(suffix).png"))
        }
        window.appearance = NSAppearance(named: .aqua)
        drain(80)
    }

    private func alpha(at location: Int) -> CGFloat {
        (editor?.textStorage?.attribute(.foregroundColor, at: location, effectiveRange: nil) as? NSColor)?.alphaComponent ?? -1
    }

    func testEditCorrectsProgressivelyInTheEditor() throws {
        try capture("01-idle")
        try press("mac.newSession.voice")
        drain(300)
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: key))
        XCTAssertEqual(app.iosVoiceComposer.rawText, raw)
        XCTAssertFalse(views(window.contentView!).compactMap { $0 as? MacComposerVoiceTranscriptView }.isEmpty,
                       "recording uses the chat Composer's transcript surface")
        XCTAssertEqual(draft, "", "the draft is untouched while recording")
        try capture("02-recording")

        try press("voice-to-text")
        XCTAssertEqual(draft, raw)
        let pending = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: key))
        XCTAssertEqual(alpha(at: pending.location), 0.5, accuracy: 0.01, "uncorrected text is faded")
        try capture("03-edit-pending")

        driver.emit(.correctionDelta("\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki\u{FF0C}"))
        drain(150)
        let rest = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: key))
        XCTAssertGreaterThan(rest.location, 0)
        XCTAssertEqual(alpha(at: 0), NSColor.labelColor.alphaComponent, accuracy: 0.01, "corrected text is normal")
        XCTAssertEqual(alpha(at: rest.location), 0.5, accuracy: 0.01)
        try capture("04-edit-progress")

        driver.emit(.final(corrected, rawText: raw))
        drain(200)
        XCTAssertEqual(draft, corrected)
        XCTAssertNil(app.iosVoiceComposer.operation)
        XCTAssertTrue(createdPrompts.isEmpty, "Edit never starts a session")
        try capture("05-edit-final")
    }

    func testSendWhileRecordingStartsWithTheCorrectedText() throws {
        try press("mac.newSession.voice")
        drain(300)
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: key))
        try press("mac.newSession.create")
        XCTAssertFalse(app.iosVoiceComposer.isRecording)
        XCTAssertTrue(createdPrompts.isEmpty, "raw speech is never sent")
        XCTAssertNotNil(app.iosVoiceComposer.uncorrectedRange(in: key), "the correction shows in the editor while waiting")
        try capture("06-send-waiting")

        driver.emit(.correctionDelta("\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}"))
        drain(150)
        XCTAssertTrue(createdPrompts.isEmpty)
        driver.emit(.final(corrected, rawText: raw))
        drain(300)
        XCTAssertEqual(createdPrompts, [corrected])
        XCTAssertEqual(draft, "")
    }

    func testTypingDuringASendCorrectionCallsTheSendOff() throws {
        try press("mac.newSession.voice")
        drain(300)
        try press("mac.newSession.create")
        let editor = try XCTUnwrap(editor)
        editor.setSelectedRange(NSRange(location: 0, length: 1))
        window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: 1, length: 0))
        drain(80)
        XCTAssertTrue(app.iosVoiceComposer.operation?.dirty == true)
        driver.emit(.final(corrected, rawText: raw))
        drain(300)
        XCTAssertTrue(createdPrompts.isEmpty, "the user took over; nothing starts by itself")
        XCTAssertEqual(draft, raw, "a late correction never overwrites the user's draft")
    }

    private func keyReturn(_ editor: NSTextView, modifiers: NSEvent.ModifierFlags = []) throws {
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
            characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        editor.keyDown(with: event)
        drain(200)
    }

    /// Chinese/Japanese input: Return while composing commits the composition
    /// (e.g. the typed Latin letters); it never starts the Session.
    func testReturnWhileComposingCommitsAndDoesNotStart() throws {
        let editor = try XCTUnwrap(editor)
        XCTAssertTrue(window.makeFirstResponder(editor))
        editor.insertText("Fix ", replacementRange: editor.selectedRange())
        drain(150)
        editor.setMarkedText("kraki", selectedRange: NSRange(location: 5, length: 0), replacementRange: editor.selectedRange())
        XCTAssertTrue(editor.hasMarkedText())
        try keyReturn(editor)
        // A real input method consumes this Return and commits; without one
        // AppKit inserts a newline. Either way nothing may be sent.
        XCTAssertTrue(createdPrompts.isEmpty, "Return during composition must not send")

        // The input method commits the composition (what Return does with one).
        editor.string = ""
        app.sessionStore.setDraft(key, "")
        editor.insertText("Fix ", replacementRange: NSRange(location: 0, length: 0))
        editor.setMarkedText("kraki", selectedRange: NSRange(location: 5, length: 0), replacementRange: editor.selectedRange())
        editor.insertText("kraki", replacementRange: editor.markedRange())
        drain(150)
        XCTAssertFalse(editor.hasMarkedText())
        XCTAssertEqual(draft, "Fix kraki")
        XCTAssertTrue(createdPrompts.isEmpty)
        try keyReturn(editor)
        XCTAssertEqual(createdPrompts, ["Fix kraki"], "Return without a composition starts the Session")
    }

    func testShiftReturnAddsALine() throws {
        let editor = try XCTUnwrap(editor)
        XCTAssertTrue(window.makeFirstResponder(editor))
        editor.insertText("first", replacementRange: editor.selectedRange())
        try keyReturn(editor, modifiers: .shift)
        XCTAssertTrue(createdPrompts.isEmpty)
        XCTAssertTrue(draft.hasPrefix("first\n"))
    }

    func testLevelBarsSitInTheBottomRowWhileRecording() throws {
        try press("mac.newSession.voice")
        drain(300)
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: key))
        let transcript = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? MacComposerVoiceTranscriptView }.first)
        let cancel = try XCTUnwrap(views(window.contentView!).first { $0.identifier?.rawValue == "voice-cancel" })
        let t = transcript.convert(transcript.bounds, to: nil), c = cancel.convert(cancel.bounds, to: nil)
        XCTAssertGreaterThan(t.minY, c.maxY, "the transcript is above the bottom row (window coordinates are bottom-up)")
        XCTAssertEqual(c.minY, try XCTUnwrap(views(window.contentView!).first { $0.identifier?.rawValue == "mac.newSession.create" })
            .convert(.zero, to: nil).y, accuracy: 8, "Cancel / Edit share the send button's row")
    }

    func testCancelKeepsTheTypedDraft() throws {
        app.sessionStore.setDraft(key, "Typed first")
        drain(150)
        try press("mac.newSession.voice")
        drain(300)
        XCTAssertTrue(app.iosVoiceComposer.isRecording(in: key))
        try capture("07-recording-with-draft")
        try press("voice-cancel")
        XCTAssertNil(app.iosVoiceComposer.operation)
        XCTAssertEqual(draft, "Typed first")
        XCTAssertTrue(createdPrompts.isEmpty)
    }
}
#endif
