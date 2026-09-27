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
            }
            return true
        }
        window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 820, height: 580),
                          styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = "Kraki · Voice parity (isolated test)"
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = NSHostingView(rootView: MacChatView(sessionId: sid, prebuiltViewModel: ChatViewModel(sessionId: sid, appState: app)).environment(app))
        window.orderFrontRegardless()
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 0, deviceId: "voice-test-device")
        drain(700)
    }
    override func tearDown() {
        app.iosVoiceComposer.retireKeepingDraft()
        app.voiceInputController.forgetLease()
        window.orderOut(nil); window.contentView = nil
        window = nil; app = nil; sent = []; sentAttachmentCounts = []
        super.tearDown()
    }
    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func press(_ id: String) throws {
        // Exercise the production floating composer's actual hit testing.
        let x: CGFloat
        switch id {
        case "chat-voice-microphone", "voice-to-text": x = 738
        case "voice-send": x = 786
        case "voice-cancel": x = 46
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
        // Optional WindowServer capture preserves the real glass/material.
        let shot = Process()
        shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        shot.arguments = ["-x", "-o", "-l", String(window.windowNumber), url.path]
        try? shot.run(); shot.waitUntilExit()
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
