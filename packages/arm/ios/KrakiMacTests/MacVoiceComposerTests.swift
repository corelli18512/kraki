import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// Production MacChatView + real AppKit/SwiftUI controls; synthetic speech and
/// captured transport only. No production app, microphone or network.
@MainActor final class MacVoiceComposerTests: XCTestCase {
    private var app: AppState!
    private var window: NSWindow!
    private var sent: [String] = []
    private var sentAttachmentCounts: [Int] = []
    private var sentAnswerIDs: [String?] = []
    private var sentDeliveries: [String?] = []
    private let sid = "voice-a"
    private let raw = "请把这个功能接入 Kraki 保留原来的输入框"
    private let corrected = "请把这个功能接入 Kraki，保留原来的输入框。"

    override func setUp() {
        super.setUp()
        app = IOSVoiceHoldScenarioFixture.makeAppState()
        app.testOutboundMessageHandler = { [weak self] payload, _, _ in
            if payload["type"] as? String == "send_input" {
                self?.sent.append((payload["payload"] as? [String: Any])?["text"] as? String ?? "")
                self?.sentAttachmentCounts.append(((payload["payload"] as? [String: Any])?["attachments"] as? [Any])?.count ?? 0)
                self?.sentAnswerIDs.append((payload["payload"] as? [String: Any])?["answerTo"] as? String)
                self?.sentDeliveries.append((payload["payload"] as? [String: Any])?["delivery"] as? String)
            }
            return true
        }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 0, deviceId: "voice-test-device")
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 820, height: 580),
                          styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = "Kraki · Voice parity (isolated test)"
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = NSHostingView(rootView: MacChatView(sessionId: sid, prebuiltViewModel: ChatViewModel(sessionId: sid, appState: app)).environment(app))
        window.level = .floating
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        drain(700)
    }
    override func tearDown() {
        app.iosVoiceComposer.retireKeepingDraft()
        app.voiceInputController.forgetLease()
        window.orderOut(nil); window.contentView = nil
        window = nil; app = nil; sent = []; sentAttachmentCounts = []
        sentAnswerIDs = []; sentDeliveries = []
        super.tearDown()
    }
    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func press(_ id: String) throws {
        // Exercise the production floating composer's actual hit testing.
        let x: CGFloat
        switch id {
        case "chat-voice-microphone": x = 738
        case "voice-to-text": x = 723
        case "voice-send": x = 786
        case "voice-cancel": x = 649
        case "image": x = 40
        default: XCTFail("unknown control"); return
        }
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: 27), modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        drain(350)
    }
    private func capture(_ name: String) throws {
        let view = try XCTUnwrap(window.contentView)
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let dir = URL(fileURLWithPath: "/tmp/kraki-voice-parity-evidence")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("mac-\(name).png")
        try data.write(to: url)
        // Optional external WindowServer capture preserves Liquid Glass's
        // composited layers (cacheDisplay cannot render them). A local runner
        // may watch these requests; tests themselves need no capture access.
        let request = ["window": String(window.windowNumber), "name": "mac-\(name)"]
        try JSONSerialization.data(withJSONObject: request).write(to: dir.appendingPathComponent("capture-request.json"), options: .atomic)
        drain(500)
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
        attachment.name = "mac-\(name)"; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testNativeSendCorrectsInBubbleAndFreesComposer() throws {
        try capture("01-idle")
        try press("chat-voice-microphone")
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        XCTAssertEqual(app.iosVoiceComposer.rawText, raw)
        try capture("02-recording")
        try press("voice-send")
        XCTAssertFalse(app.iosVoiceComposer.isRecording)
        XCTAssertEqual(app.sessionStore.drafts[sid] ?? "", "")
        XCTAssertTrue(sent.isEmpty, "staging must NOT transmit raw speech")
        let pending = try XCTUnwrap(app.commandSender?.pendingInputs(sid).first)
        XCTAssertEqual(pending.payload["localState"]?.stringValue, "correcting")
        XCTAssertFalse(app.iosVoiceComposer.isRecording)
        let content = MacChatBubbleContentBuilder.make(message: pending, sessionId: sid, agent: "pi", documentWidth: 800)
        XCTAssertEqual(content.pendingDeliveryState, "correcting")
        // Verify rendered fade via the same content passed to the native row.
        let body = try XCTUnwrap(content.body)
        let color = body.attribute(.foregroundColor, at: body.length - 1, effectiveRange: nil) as? NSColor
        XCTAssertEqual(color?.alphaComponent ?? 0, 0.5, accuracy: 0.01)
        try capture("03-bubble-correcting")
        app.sessionStore.setDraft(sid, "下一条消息可以继续输入")
        drain(80)
        try press("voice-send")
        XCTAssertTrue(sent.isEmpty, "typed follow-up waits for voice correction, preserving send order")
        drain(2100)
        XCTAssertEqual(sent, [corrected])
        XCTAssertEqual(app.sessionStore.drafts[sid], "下一条消息可以继续输入")
        try capture("04-sent")
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }

    func testSendOriginalUsesLateRawAndDeleteFencesCorrection() throws {
        for action in ["Send Original", "Delete"] {
            try press("chat-voice-microphone")
            try press("voice-send")
            app.voiceInputController.debugApplyPartial(raw + " 最后补充")
            drain(120)
            let cell = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? MacChatBubbleCell }.first(where: {
                $0.deliveryStatusForRegression?.contains("Correcting") == true
            }))
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
            let menu = try XCTUnwrap(cell.menu(for: event))
            XCTAssertEqual(menu.items.suffix(3).map(\.title), ["Send Original", "Edit", "Delete"])
            let index = menu.indexOfItem(withTitle: action)
            XCTAssertGreaterThanOrEqual(index, 0)
            menu.performActionForItem(at: index)
            drain(2100)
            XCTAssertEqual(sent, [raw + " 最后补充"], "late correction must not resend or resurrect deleted input")
            app.commandSender?.clearAllPending(sid)
            drain(100)
        }
    }

    func testBubbleEditPreservesImageAndLateCorrectionCannotSend() throws {
        try press("chat-voice-microphone")
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
                                      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                      bytesPerRow: 0, bitsPerPixel: 0)!
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertTrue(app.iosVoiceComposer.send(attachments: [.init(type: "image", mimeType: "image/png", data: data.base64EncodedString())], delivery: .prompt))
        drain(300)
        let cell = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? MacChatBubbleCell }.first(where: {
            $0.deliveryStatusForRegression?.contains("Correcting") == true
        }))
        let event = try XCTUnwrap(NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
        let menu = try XCTUnwrap(cell.menu(for: event))
        menu.performActionForItem(at: menu.indexOfItem(withTitle: "Edit"))
        drain(2100)
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(app.sessionStore.drafts[sid], raw)
        XCTAssertTrue(app.commandSender?.pendingInputs(sid).isEmpty == true)
        try press("voice-send") // same physical primary button, now normal Send
        XCTAssertEqual(sent, [raw])
        XCTAssertEqual(sentAttachmentCounts, [1])
    }

    func testFreeFormVoiceAnswerUsesOriginalQuestionAndNeverSteers() throws {
        let questionID = "voice-parity-question"
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 1, deviceId: "voice-test-device")
        let question: [String: Any] = [
            "type": "agent_message", "seq": 1, "sessionId": sid, "deviceId": "voice-test-device",
            "timestamp": ISO8601.now(),
            "payload": ["content": "我需要确认一下。", "question": ["id": questionID, "text": "新会话默认用哪个模型？"]]
        ]
        app.messageProvider?.ingestTailCandidate(sid, json: try JSONSerialization.data(withJSONObject: question))
        app.sessionStore.sessions[sid]?.lastSeq = 1
        app.sessionStore.sessions[sid]?.state = .active
        drain(500)
        let viewModel = ChatViewModel(sessionId: sid, appState: app)
        XCTAssertEqual(viewModel.questions.last?.id, questionID, "fixture must expose a live free-form question")
        try press("chat-voice-microphone")
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        try capture("06-freeform-recording")
        try press("voice-send")
        let pending = try XCTUnwrap(app.commandSender?.pendingInputs(sid).first)
        XCTAssertEqual(pending.answerTo, questionID)
        XCTAssertEqual(pending.payload["localState"]?.stringValue, "correcting")
        XCTAssertNil(pending.payload["delivery"])
        XCTAssertEqual(app.sessionStore.drafts[sid] ?? "", "")
        XCTAssertTrue(sent.isEmpty)
        try capture("07-freeform-correcting")
        drain(2100)
        XCTAssertEqual(sent, [corrected])
        XCTAssertEqual(sentAnswerIDs, [questionID])
        XCTAssertEqual(sentDeliveries.count, 1)
        XCTAssertNil(sentDeliveries.first!)
        try capture("08-freeform-sent")
    }

    func testRecordingKeepsDisabledThumbnailAndSendsIt() throws {
        let image = NSImage(size: NSSize(width: 28, height: 28), flipped: false) { rect in
            NSColor.systemTeal.setFill(); rect.fill(); return true
        }
        let tiff = try XCTUnwrap(image.tiffRepresentation)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: tiff))
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let sender = try XCTUnwrap(app.commandSender)
        let clientID = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "", attachments: [
            .init(type: "image", mimeType: "image/png", data: data.base64EncodedString())
        ]))
        NotificationCenter.default.post(name: .krakiVoiceEditRequested, object: nil,
                                        userInfo: ["sessionId": sid, "clientId": clientID])
        drain(200)
        try press("chat-voice-microphone")
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        try capture("09-recording-thumbnail")
        try press("image") // disabled: no picker, no removal
        XCTAssertNil(window.attachedSheet)
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        try press("voice-send")
        XCTAssertEqual(sender.pendingInputs(sid).first?.attachments?.first?.data, data.base64EncodedString())
        drain(2100)
        XCTAssertEqual(sentAttachmentCounts, [1])
        XCTAssertEqual(sent, [corrected])
    }

    func testBackgroundWaveformTracksLevelsAndDoesNotMoveCenteredText() throws {
        try press("chat-voice-microphone")
        let transcript = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? MacComposerVoiceTranscriptView }.first)
        let initialFrame = transcript.convert(transcript.bounds, to: window.contentView)
        XCTAssertGreaterThan(transcript.textDrawingRect.minY, 0, "short text must not sit at the top of its viewport")
        XCTAssertEqual(transcript.textDrawingRect.midY, transcript.bounds.midY, accuracy: 0.5)
        let driver = IOSVoiceHoldScenarioFixture.driver
        for _ in 0..<40 { driver.emitLevel(0) }
        drain(300)
        try capture("10-waveform-quiet")
        let quiet = MacVoiceBackgroundWaveform.heightFractions(levels: app.voiceInputController.levels, count: 80)
        for level: Float in [0.015, 0.03, 0.07, 0.24, 0.19, 0.1, 0.035, 0.02] { driver.emitLevel(level) }
        drain(300)
        try capture("11-waveform-speaking")
        let speaking = MacVoiceBackgroundWaveform.heightFractions(levels: app.voiceInputController.levels, count: 80)
        XCTAssertEqual(quiet.count, 80)
        XCTAssertGreaterThan(speaking.max() ?? 0, (quiet.max() ?? 0) + 0.4)
        XCTAssertEqual(transcript.convert(transcript.bounds, to: window.contentView), initialFrame,
                       "background audio animation must not change text layout")
        // Multi-line speech still uses the full native scroll document.
        app.voiceInputController.debugApplyPartial(String(repeating: "这是一段较长的语音，需要保留最新的文字。", count: 12))
        drain(150)
        XCTAssertGreaterThan(transcript.contentHeight, MacComposerVoiceTranscriptView.lineHeight * 2)
        XCTAssertEqual(transcript.textDrawingRect.minY, 0, accuracy: 0.5)
        try capture("12-waveform-long-transcript")
        try press("voice-cancel") // backdrop must not intercept any controls
        XCTAssertFalse(app.iosVoiceComposer.isRecording)
    }

    func testRecordingDuringAgentTurnSendsSteerInsteadOfAbort() throws {
        app.sessionStore.sessions[sid]?.state = .active
        drain(200)
        try press("chat-voice-microphone")
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        try press("voice-send")
        XCTAssertEqual(app.commandSender?.pendingInputs(sid).first?.payload["delivery"]?.stringValue, "steer")
        drain(2100)
        XCTAssertEqual(sent, [corrected])
    }
    func testCancelKeepsExistingDraftAndLateResultCannotSend() throws {
        app.sessionStore.setDraft(sid, "保留的草稿")
        drain(150)
        try press("chat-voice-microphone")
        try press("voice-cancel")
        drain(2100)
        XCTAssertEqual(app.sessionStore.drafts[sid], "保留的草稿")
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(app.commandSender?.pendingInputs(sid).isEmpty == true)
    }
    func testEditReturnsToSameInputAndHumanTypingWins() throws {
        try press("chat-voice-microphone")
        try press("voice-to-text")
        XCTAssertEqual(app.sessionStore.drafts[sid], raw)
        XCTAssertFalse(app.iosVoiceComposer.isRecording)
        try capture("05-edit")
        let editor = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? NSTextView }.first(where: { $0.isEditable }))
        XCTAssertEqual(editor.selectedRange().location, raw.utf16.count, "editing resumes after the spoken text")
        editor.insertText(" human", replacementRange: editor.selectedRange())
        drain(2100)
        XCTAssertEqual(app.sessionStore.drafts[sid], raw + " human")
        XCTAssertTrue(sent.isEmpty)
    }
}
