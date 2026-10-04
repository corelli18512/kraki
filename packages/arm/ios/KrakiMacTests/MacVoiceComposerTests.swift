import XCTest
import SwiftUI
import AppKit
import CryptoKit
@testable import Kraki_Dev

/// Production MacChatView + real AppKit/SwiftUI controls; synthetic speech and
/// captured transport only. No production app, microphone or network.
@MainActor final class MacVoiceComposerTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    private var app: AppState!
    private var window: NSWindow!
    private var sent: [String] = []
    private var sentAttachmentCounts: [Int] = []
    private var sentAnswerIDs: [String?] = []
    private var sentDeliveries: [String?] = []
    private let sid = "voice-a"
    private let raw = "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki \u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}"
    private let corrected = "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki\u{FF0C}\u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}\u{3002}"

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
        let point: CGPoint
        if id == "chat-voice-microphone" || id == "voice-send" {
            point = CGPoint(x: id == "voice-send" ? 786 : 738,
                            y: MacComposerMetrics.bottomPadding + MacComposerMetrics.capsuleHeight / 2)
        } else {
            let frame = try controlFrame(id == "image" ? "chat-attach-image" : id)
            point = CGPoint(x: frame.midX, y: frame.midY)
        }
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        drain(350)
    }
    private func controlFrame(_ id: String) throws -> CGRect {
        let marker = try XCTUnwrap(views(window.contentView!).first { $0.identifier?.rawValue == id },
                                   "missing production control geometry: \(id)")
        return marker.convert(marker.bounds, to: nil)
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
        let request = ["window": String(window.windowNumber), "name": "mac-\(name)", "pid": String(ProcessInfo.processInfo.processIdentifier)]
        try JSONSerialization.data(withJSONObject: request).write(to: dir.appendingPathComponent("capture-request.json"), options: .atomic)
        drain(500)
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
        attachment.name = "mac-\(name)"; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testSelectedD1CueIsBundledAndUnchanged() throws {
        let data = try XCTUnwrap(NSDataAsset(name: "VoiceStartCue")?.data)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, "d16a5be4e7390c40225bd3024462212dfa26cd24a07080014f14c6794b6a3f9e")
        let sound = try XCTUnwrap(NSSound(data: data))
        XCTAssertEqual(sound.duration, 0.202, accuracy: 0.005)
    }

    func testSingleAndMultilinePaddingStaysOutsideScrollingViewport() throws {
        let host = NSHostingView(rootView: MacChatComposer(sessionId: sid).environment(app))
        host.sizingOptions = [.intrinsicContentSize]
        window.contentView = host
        window.setContentSize(NSSize(width: 820, height: 100))
        var measurements: [[String: Any]] = []
        func measure(_ name: String, voice: Bool, expectedHeight: CGFloat) throws {
            drain(250)
            // Avoid using a stale fitting size from the previously mounted
            // full Chat view as the first window-height proposal.
            window.setContentSize(NSSize(width: 820, height: expectedHeight + (MacComposerMetrics.verticalPadding + MacComposerMetrics.bottomPadding)))
            drain(150)
            host.layoutSubtreeIfNeeded()
            let height = host.fittingSize.height - (MacComposerMetrics.verticalPadding + MacComposerMetrics.bottomPadding)
            XCTAssertEqual(height, expectedHeight, accuracy: 0.5, name)
            let scroll: NSScrollView
            let drawn: CGRect
            if voice {
                let v = try XCTUnwrap(views(host).compactMap { $0 as? MacComposerVoiceTranscriptView }.first)
                scroll = try XCTUnwrap(v.enclosingScrollView)
                drawn = v.convert(v.textDrawingRect, to: nil)
                if name.contains("overflow") {
                    XCTAssertGreaterThan(v.contentHeight, scroll.contentView.bounds.height)
                    XCTAssertEqual(scroll.contentView.bounds.maxY, v.bounds.height, accuracy: 1)
                }
            } else {
                let v = try XCTUnwrap(views(host).compactMap { $0 as? NSTextView }.first(where: { $0.isEditable }))
                scroll = try XCTUnwrap(v.enclosingScrollView)
                let c = try XCTUnwrap(v.textContainer)
                let layout = try XCTUnwrap(v.layoutManager)
                layout.ensureLayout(for: c)
                let used = layout.usedRect(for: c).offsetBy(dx: v.textContainerOrigin.x, dy: v.textContainerOrigin.y)
                drawn = v.convert(used, to: nil)
            }
            let viewport = scroll.contentView.convert(scroll.contentView.bounds, to: nil)
            let top = MacComposerMetrics.bottomPadding + height - viewport.maxY
            let bottom = viewport.minY - MacComposerMetrics.bottomPadding
            XCTAssertEqual(top, MacComposerMetrics.textVerticalPadding, accuracy: 0.5, name)
            XCTAssertEqual(bottom, MacComposerMetrics.textVerticalPadding, accuracy: 0.5, name)
            let visible = drawn.intersection(viewport)
            let topText = MacComposerMetrics.bottomPadding + height - visible.maxY
            let bottomText = visible.minY - MacComposerMetrics.bottomPadding
            if !name.contains("overflow") && !name.contains("trailing") {
                // Two-line voice now accommodates a 64pt action column:
                // text remains centered, with the same 8pt outer viewport inset.
                let expectedTextPadding = (height - visible.height) / 2
                XCTAssertEqual(topText, expectedTextPadding, accuracy: 0.5, name)
                XCTAssertEqual(bottomText, expectedTextPadding, accuracy: 0.5, name)
            }
            measurements.append(["state": name, "capsuleHeight": height, "topSpace": topText,
                                 "bottomSpace": bottomText, "viewportTopPadding": top, "viewportBottomPadding": bottom])
            try capture("padding-fixed-" + name)
        }
        let samples: [(String, String, CGFloat)] = [
            ("one", "\u{7B2C}\u{4E00}\u{884C}\u{6587}\u{5B57}", 36), ("two", "\u{7B2C}\u{4E00}\u{884C}\u{6587}\u{5B57}\n\u{7B2C}\u{4E8C}\u{884C}\u{6587}\u{5B57}", 54),
            ("three", "\u{7B2C}\u{4E00}\u{884C}\u{6587}\u{5B57}\n\u{7B2C}\u{4E8C}\u{884C}\u{6587}\u{5B57}\n\u{7B2C}\u{4E09}\u{884C}\u{6587}\u{5B57}", 72),
            ("overflow", String(repeating: "\u{8FD9}\u{662F}\u{4E00}\u{6BB5}\u{81EA}\u{52A8}\u{6362}\u{884C}\u{7684}\u{4E2D}\u{6587}\u{6587}\u{5B57}\u{3002}", count: 20), 72)
        ]
        for (name, text, height) in samples {
            app.sessionStore.setDraft(sid, text)
            try measure("typed-" + name, voice: false, expectedHeight: height)
        }
        app.sessionStore.setDraft(sid, "\u{7B2C}\u{4E00}\u{884C}\u{6587}\u{5B57}\n")
        try measure("typed-trailing-newline", voice: false, expectedHeight: 54)
        app.sessionStore.setDraft(sid, "")
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(400)
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        for (name, text, height) in samples {
            app.voiceInputController.debugApplyPartial(text)
            try measure("voice-" + name, voice: true, expectedHeight: name == "two" ? 70 : height)
        }
        try JSONSerialization.data(withJSONObject: measurements, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: "/tmp/kraki-voice-parity-evidence/padding-fixed.json"))
    }

    func testMultilineActionsShareRightColumnAndImageIsCentered() throws {
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(400)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            window.appearance = NSAppearance(named: appearance)
            for (name, speech) in [("one", "Short speech"), ("two", "First line\nSecond line"),
                                   ("long", String(repeating: "More space for a high-contrast live transcript. ", count: 12))] {
                // Independent layout samples, not successive ASR segments.
                app.iosVoiceComposer.receive(speech, id: try XCTUnwrap(app.iosVoiceComposer.operation).id)
                drain(220)
                let transcript = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? MacComposerVoiceTranscriptView }.first)
                let scroll = try XCTUnwrap(transcript.enclosingScrollView)
                let viewport = scroll.convert(scroll.bounds, to: nil)
                let cancel = try controlFrame("voice-cancel"), edit = try controlFrame("voice-to-text")
                let image = try controlFrame("chat-attach-image")
                XCTAssertEqual(image.midY, viewport.midY, accuracy: 0.5)
                if name == "one" {
                    XCTAssertEqual(cancel.midY, edit.midY, accuracy: 0.5)
                    XCTAssertLessThan(cancel.maxX, edit.minX)
                    XCTAssertEqual(viewport.height, 20, accuracy: 0.5)
                    XCTAssertEqual(cancel.width, 70, accuracy: 0.5)
                    XCTAssertEqual(edit.width, 62, accuracy: 0.5, "single-row footprint stays unchanged")
                } else {
                    XCTAssertEqual(cancel.width, 70, accuracy: 0.5)
                    XCTAssertEqual(edit.width, cancel.width, accuracy: 0.5)
                    XCTAssertEqual(cancel.minX, edit.minX, accuracy: 0.5)
                    XCTAssertEqual(cancel.maxX, edit.maxX, accuracy: 0.5)
                    XCTAssertEqual(cancel.midX, edit.midX, accuracy: 0.5)
                    XCTAssertGreaterThan(cancel.minY, edit.maxY, "Cancel above Edit in AppKit coordinates")
                    XCTAssertGreaterThan(viewport.width, 600, "stacking recovers the old second button's width")
                    XCTAssertLessThan(viewport.maxX, cancel.minX)
                }
                transcript.debugAttributedText.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: transcript.debugAttributedText.length)) { color, _, _ in
                    XCTAssertEqual((color as? NSColor)?.alphaComponent ?? -1, 1, accuracy: 0.01)
                }
                try capture("polish-\(appearance == .aqua ? "light" : "dark")-\(name)")
            }
        }
        try press("voice-cancel")
        XCTAssertFalse(app.iosVoiceComposer.isRecording, "stacked Cancel remains a real hit target")
        app.sessionStore.setDraft(sid, "Typed first line\nTyped second line\nTyped third line")
        drain(250)
        let editor = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? NSTextView }.first(where: \.isEditable))
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        XCTAssertEqual(try controlFrame("chat-attach-image").midY, scroll.convert(scroll.bounds, to: nil).midY, accuracy: 0.5)
        try capture("polish-typed-multiline")
    }

    func testWrapDecisionIsStableWhenStackingFreesAWholeLine() {
        let speech = "A sentence close to the single-row wrapping boundary."
        let pieces = [(text: speech, opacity: 1.0)]
        for width in stride(from: CGFloat(210), through: 700, by: 5) {
            let layout = MacVoiceSurfaceLayout(pieces: pieces)
            let a = layout.geometry(width: width), b = layout.geometry(width: width)
            XCTAssertEqual(a.stacked, b.stacked)
            XCTAssertEqual(a.transcript, b.transcript)
            XCTAssertEqual(a.height, b.height)
            if a.stacked {
                XCTAssertEqual(a.cancel.width, a.edit.width)
                XCTAssertEqual(a.cancel.minX, a.edit.minX)
                XCTAssertEqual(a.cancel.maxX, a.edit.maxX)
                XCTAssertEqual(a.cancel.midX, a.edit.midX)
                XCTAssertLessThan(a.cancel.maxY, a.edit.minY)
            }
        }
    }

    func testEditProgressTintAndNativeSelectionTakeover() throws { try assertEditTakeover(markedIME: false) }
    func testEditProgressStopsBeforeMarkedIMECommits() throws { try assertEditTakeover(markedIME: true) }

    private func assertEditTakeover(markedIME: Bool) throws {
        app.voiceInputController.forgetLease()
        let driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        window.contentView = NSHostingView(rootView: MacChatView(sessionId: sid, prebuiltViewModel: ChatViewModel(sessionId: sid, appState: app)).environment(app))
        drain(300)
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(400)
        app.voiceInputController.debugApplyPartial(raw + "\nKeep this second line while correcting.")
        drain(150)
        try press("voice-to-text")
        let editor = try XCTUnwrap(views(window.contentView!).compactMap { $0 as? NSTextView }.first(where: \.isEditable))
        XCTAssertFalse(app.iosVoiceComposer.operation?.dirty ?? true, "automatic focus must not look like human takeover")
        var pending = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: sid))
        XCTAssertEqual((editor.textStorage?.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? NSColor)?.alphaComponent ?? -1, 0.5, accuracy: 0.01)
        try capture("polish-edit-pending")
        driver.emit(.correctionDelta("请将这个功能接入 Kraki，"))
        drain(120)
        pending = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: sid))
        XCTAssertGreaterThan(pending.location, 0)
        XCTAssertTrue(editor.string.hasPrefix("请将这个功能接入 Kraki，"))
        XCTAssertEqual((editor.textStorage?.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? NSColor)?.alphaComponent ?? -1, 0.5, accuracy: 0.01)
        XCTAssertEqual((editor.textStorage?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor)?.alphaComponent ?? -1, NSColor.labelColor.alphaComponent, accuracy: 0.01)
        try capture("polish-edit-progress")
        for appearance in [NSAppearance.Name.darkAqua, .aqua] {
            window.appearance = NSAppearance(named: appearance)
            drain(120)
            let color = try XCTUnwrap((editor.textStorage?.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? NSColor)?.usingColorSpace(.deviceRGB))
            XCTAssertEqual(color.alphaComponent, 0.5, accuracy: 0.01)
            if appearance == .aqua { XCTAssertLessThan(color.redComponent, 0.2) }
            else { XCTAssertGreaterThan(color.redComponent, 0.8) }
        }
        window.makeKeyAndOrderFront(nil)
        XCTAssertTrue(window.makeFirstResponder(editor))
        XCTAssertTrue(window.firstResponder === editor)
        if markedIME {
            editor.setMarkedText("正在输入", selectedRange: NSRange(location: 4, length: 0), replacementRange: editor.selectedRange())
        } else {
            editor.setSelectedRange(NSRange(location: 0, length: 1))
        }
        drain(50)
        let visible = editor.string, selection = editor.selectedRange()
        XCTAssertTrue(app.iosVoiceComposer.operation?.dirty == true)
        XCTAssertNil(app.iosVoiceComposer.uncorrectedRange(in: sid))
        driver.emit(.correctionDelta("LATE")); driver.emit(.final("LATE FINAL", rawText: raw))
        drain(150)
        XCTAssertEqual(editor.string, visible)
        XCTAssertEqual(editor.selectedRange(), selection)
        if markedIME { XCTAssertTrue(editor.hasMarkedText()); editor.unmarkText() }
        XCTAssertEqual(driver.sentCount, 0)
    }

    func testSingleLineAndRecordingCapsulesMatchPrimaryHeight() throws {
        let host = NSHostingView(rootView: MacChatComposer(sessionId: sid).environment(app))
        window.contentView = host
        window.setContentSize(NSSize(width: 820, height: 100))
        drain(300)
        XCTAssertEqual(MacComposerMetrics.capsuleHeight, MacComposerMetrics.control)
        let expectedHeight = MacComposerMetrics.control + (MacComposerMetrics.verticalPadding + MacComposerMetrics.bottomPadding)
        let idleHeight = host.fittingSize.height
        XCTAssertEqual(idleHeight, expectedHeight, accuracy: 0.5)
        try capture("equal-height-idle")
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(500)
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        XCTAssertEqual(host.fittingSize.height, idleHeight, accuracy: 0.5,
                       "entering recording must not resize the composer")
        let transcript = try XCTUnwrap(views(host).compactMap { $0 as? MacComposerVoiceTranscriptView }.first)
        XCTAssertEqual(transcript.enclosingScrollView?.bounds.height ?? 0, MacComposerMetrics.minimumTextHeight, accuracy: 0.5)
        try capture("equal-height-recording")
        app.iosVoiceComposer.cancel()
        drain(300)
        XCTAssertEqual(host.fittingSize.height, idleHeight, accuracy: 0.5)
    }

    /// Real MacChatView cold open: the trailing question is drawn while the head
    /// is unknown; session_list then reports that head without a store change.
    func testColdOpenQuestionGetsChoicesWhenHeadArrives() throws {
        app.messageProvider?.observeLiveMessageSeq(sid, seq: 40, kind: "test")
        let question: [String: Any] = [
            "type": "agent_message", "seq": 1, "sessionId": sid, "deviceId": "voice-test-device",
            "timestamp": ISO8601.now(),
            "payload": ["content": "\u{6211}\u{770B}\u{4E86}\u{4E00}\u{4E0B}\u{FF0C}\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}\u{3002}", "question": ["id": "cold-q", "text": "\u{9009}\u{54EA}\u{4E2A}\u{FF1F}", "choices": ["\u{65B9}\u{6848}\u{7532}", "\u{65B9}\u{6848}\u{4E59}"]]]
        ]
        app.messageProvider?.ingestTailCandidate(sid, json: try JSONSerialization.data(withJSONObject: question))
        drain(700)
        func choices() -> [String]? {
            views(window.contentView!).compactMap { $0 as? MacChatBubbleCell }
                .compactMap { $0.content?.action?.choices }.first
        }
        let before = choices()
        // session_list: the authoritative head equals the loaded window.
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 1, deviceId: "voice-test-device")
        app.sessionStore.sessions[sid]?.lastSeq = 1
        drain(900)
        let after = choices()
        XCTAssertNil(before, "undetermined while the head is unknown")
        XCTAssertEqual(after, ["\u{65B9}\u{6848}\u{7532}", "\u{65B9}\u{6848}\u{4E59}"], "choices must appear once the head is known")
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
        app.sessionStore.setDraft(sid, "\u{4E0B}\u{4E00}\u{6761}\u{6D88}\u{606F}\u{53EF}\u{4EE5}\u{7EE7}\u{7EED}\u{8F93}\u{5165}")
        drain(80)
        try press("voice-send")
        XCTAssertTrue(sent.isEmpty, "typed follow-up waits for voice correction, preserving send order")
        drain(2100)
        XCTAssertEqual(sent, [corrected])
        XCTAssertEqual(app.sessionStore.drafts[sid], "\u{4E0B}\u{4E00}\u{6761}\u{6D88}\u{606F}\u{53EF}\u{4EE5}\u{7EE7}\u{7EED}\u{8F93}\u{5165}")
        try capture("04-sent")
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }

    func testSendOriginalUsesLateRawAndDeleteFencesCorrection() throws {
        for action in ["Send Original", "Delete"] {
            try press("chat-voice-microphone")
            try press("voice-send")
            app.voiceInputController.debugApplyPartial(raw + " \u{6700}\u{540E}\u{8865}\u{5145}")
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
            XCTAssertEqual(sent, [raw + " \u{6700}\u{540E}\u{8865}\u{5145}"], "late correction must not resend or resurrect deleted input")
            app.commandSender?.clearAllPending(sid)
            drain(100)
        }
    }

    func testBubbleEditPreservesImageAndLateCorrectionCannotSend() throws {
        try assertBubbleEditPreservesImage()
    }

    func testFreeFormBubbleEditPreservesImageAndQuestionOnManualSend() throws {
        let questionID = "voice-parity-question"
        try installQuestion(questionID)
        try assertBubbleEditPreservesImage(answerTo: questionID)
        XCTAssertEqual(sentAnswerIDs, [questionID])
    }

    private func assertBubbleEditPreservesImage(answerTo: String? = nil) throws {
        try press("chat-voice-microphone")
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
                                      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                      bytesPerRow: 0, bitsPerPixel: 0)!
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertTrue(app.iosVoiceComposer.send(attachments: [.init(type: "image", mimeType: "image/png", data: data.base64EncodedString())], delivery: .prompt, answerTo: answerTo))
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

    private func installQuestion(_ questionID: String) throws {
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 1, deviceId: "voice-test-device")
        let question: [String: Any] = [
            "type": "agent_message", "seq": 1, "sessionId": sid, "deviceId": "voice-test-device",
            "timestamp": ISO8601.now(),
            "payload": ["content": "\u{6211}\u{9700}\u{8981}\u{786E}\u{8BA4}\u{4E00}\u{4E0B}\u{3002}", "question": ["id": questionID, "text": "\u{65B0}\u{4F1A}\u{8BDD}\u{9ED8}\u{8BA4}\u{7528}\u{54EA}\u{4E2A}\u{6A21}\u{578B}\u{FF1F}"]]
        ]
        app.messageProvider?.ingestTailCandidate(sid, json: try JSONSerialization.data(withJSONObject: question))
        app.sessionStore.sessions[sid]?.lastSeq = 1
        app.sessionStore.sessions[sid]?.state = .active
        drain(500)
        let viewModel = ChatViewModel(sessionId: sid, appState: app)
        XCTAssertEqual(viewModel.questions.last?.id, questionID, "fixture must expose a live free-form question")
    }

    func testFreeFormVoiceAnswerUsesOriginalQuestionAndNeverSteers() throws {
        let questionID = "voice-parity-question"
        try installQuestion(questionID)
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
        XCTAssertEqual(transcript.textDrawingRect.midY, transcript.bounds.midY, accuracy: 0.5)
        XCTAssertEqual(transcript.enclosingScrollView?.bounds.height ?? 0, MacComposerMetrics.minimumTextHeight, accuracy: 0.5)
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
        app.voiceInputController.debugApplyPartial(String(repeating: "\u{8FD9}\u{662F}\u{4E00}\u{6BB5}\u{8F83}\u{957F}\u{7684}\u{8BED}\u{97F3}\u{FF0C}\u{9700}\u{8981}\u{4FDD}\u{7559}\u{6700}\u{65B0}\u{7684}\u{6587}\u{5B57}\u{3002}", count: 12))
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
        app.sessionStore.setDraft(sid, "\u{4FDD}\u{7559}\u{7684}\u{8349}\u{7A3F}")
        drain(150)
        try press("chat-voice-microphone")
        try press("voice-cancel")
        drain(2100)
        XCTAssertEqual(app.sessionStore.drafts[sid], "\u{4FDD}\u{7559}\u{7684}\u{8349}\u{7A3F}")
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
