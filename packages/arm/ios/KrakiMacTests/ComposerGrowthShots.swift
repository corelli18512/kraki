#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Screenshots of the chat Composer at 1 / 2 / 3 / many lines, and frames of
/// the 1→2 line growth. Borderless window far off-screen; the headless test
/// host never shows or activates anything. Local: TEST_RUNNER_KRAKI_COMPOSER_SHOTS=1.
@MainActor
final class ComposerGrowthShots: XCTestCase {
    private var window: NSWindow!
    private var app: AppState!
    private var driver: IOSVoiceHoldScenarioDriver!
    private let sid = "voice-a"
    private let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["KRAKI_SNAPSHOT_DIR"] ?? "/tmp/kraki-composer-shots")

    private final class KeyableWindow: NSWindow { override var canBecomeKey: Bool { true } }

    override func setUp() async throws {
        if ProcessInfo.processInfo.environment["KRAKI_COMPOSER_SHOTS"] != "1" { try requireForegroundUITests() }
        MacComposerMetrics.snapshotFlatGlass = true
        driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        window = KeyableWindow(contentRect: NSRect(x: -6000, y: -6000, width: 640, height: 190), styleMask: [.borderless],
                               backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        let root = VStack(spacing: 0) {
            Spacer(minLength: 0)
            MacChatComposer(sessionId: sid)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfacePrimary)
        .environment(app)
        window.contentView = NSHostingView(rootView: root)
        window.orderFrontRegardless()
        window.makeKey()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        drain(500)
    }

    override func tearDown() async throws {
        MacComposerMetrics.snapshotFlatGlass = false
        app?.iosVoiceComposer.discard(); app?.voiceInputController.forgetLease()
        window?.orderOut(nil); window?.contentView = nil; window = nil; app = nil
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func views(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { views($0) } }
    private var editor: NSTextView { views(window.contentView!).compactMap { $0 as? NSTextView }.first(where: \.isEditable)! }

    /// cacheDisplay ignores layer masks: scroll views with an edge fade are
    /// hidden for the base image, then their layers (mask included) are
    /// rendered and composited back at their frames.
    private func shot(_ name: String) throws {
        let view = try XCTUnwrap(window.contentView)
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        let faded = views(view).compactMap { $0 as? NSScrollView }.filter { $0.layer?.mask != nil && !$0.isHidden }
        faded.forEach { $0.isHidden = true }
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        faded.forEach { $0.isHidden = false }
        if !faded.isEmpty, let ctx = NSGraphicsContext(bitmapImageRep: rep)?.cgContext {
            for scroll in faded {
                guard let layer = scroll.layer else { continue }
                let frame = scroll.convert(scroll.bounds, to: view) // view is flipped? normalize below
                let y = view.isFlipped ? view.bounds.height - frame.maxY : frame.minY
                ctx.saveGState()
                // The rep's context already maps points. CG origin is bottom-left; the layer renders top-down.
                ctx.translateBy(x: frame.minX, y: y + frame.height)
                ctx.scaleBy(x: 1, y: -1)
                window.appearance!.performAsCurrentDrawingAppearance { layer.render(in: ctx) }
                ctx.restoreGState()
            }
        }
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: dir.appendingPathComponent("\(name).png"))
    }

    static let texts: [(String, String)] = [
        ("1-line", "Fix the failing tests"),
        ("2-lines", "Fix the failing tests in my-app, then run the whole suite again and tell me what broke"),
        ("3-lines", "Fix the failing tests in my-app, then run the whole suite again and tell me what broke. Keep the public API unchanged and add a regression test for the login redirect"),
        ("many-top", (1...9).map { "Line \($0): describe one more requirement for the agent here." }.joined(separator: "\n")),
    ]

    private var fadeLog = ""
    private func logFade(_ name: String, _ scroll: NSScrollView?) {
        guard let mask = scroll?.layer?.mask as? CAGradientLayer, let colors = mask.colors as? [CGColor] else {
            fadeLog += "\(name): no fade\n"; return
        }
        fadeLog += "\(name): top=\(colors.first!.alpha < 0.5) bottom=\(colors.last!.alpha < 0.5)\n"
    }

    static let voiceTexts: [(String, String)] = [
        ("1-line", "请把这个功能接入 Kraki"),
        ("2-lines", "请把这个功能接入 Kraki，保留原来的输入框样式，然后再跑一遍测试看看有没有问题，顺便看看语音"),
        ("3-lines", String(repeating: "请把这个功能接入 Kraki，保留原来的输入框样式，", count: 4)),
        ("many", String(repeating: "请把这个功能接入 Kraki，保留原来的输入框样式，然后再跑一遍测试。", count: 9)),
    ]

    /// Voice recording in the chat Composer at 1 / 2 / 3 / many lines, plus
    /// the box height sampled every 16 ms as the transcript wraps.
    func testVoiceStates() throws {
        for (suffix, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
            drain(500)
            XCTAssertTrue(app.iosVoiceComposer.isRecording)
            for (name, text) in Self.voiceTexts {
                app.voiceInputController.debugApplyPartial(text)
                for level: Float in [0.02, 0.08, 0.2, 0.12, 0.05] { driver.emitLevel(level) }
                drain(600)
                try shot("voice-\(name)-\(suffix)")
                if name == "2-lines", let t = views(window.contentView!).compactMap({ $0 as? MacComposerVoiceTranscriptView }).first {
                    XCTAssertEqual(t.textDrawingRect.minY, t.bounds.minY, accuracy: 0.5, "two lines start at the top, not centered")
                    let viewport = try XCTUnwrap(t.enclosingScrollView)
                    XCTAssertGreaterThan(viewport.frame.height, t.contentHeight + 4, "the stacked actions make the box taller than two lines")
                    // Two lines sit at the top of the taller viewport.
                    XCTAssertEqual(t.convert(t.bounds, to: viewport).minY, viewport.contentView.convert(viewport.contentView.bounds, to: viewport).minY, accuracy: 0.5)
                    XCTAssertEqual(viewport.contentView.bounds.minY, 0, accuracy: 0.5)
                }
                if name == "many" { logFade("voice-tail-\(suffix)", views(window.contentView!).compactMap { $0 as? MacComposerVoiceTranscriptView }.first?.enclosingScrollView) }
            }
            if let scroll = views(window.contentView!).compactMap({ $0 as? MacComposerVoiceTranscriptView }).first?.enclosingScrollView {
                (scroll as? MacComposerVoiceScrollView)?.followsTail = false // as if the user scrolled back
                let clip = scroll.contentView
                clip.scroll(to: NSPoint(x: 0, y: max(0, (clip.documentRect.height - clip.bounds.height) / 2)))
                scroll.reflectScrolledClipView(clip)
                drain(300)
                try shot("voice-many-middle-\(suffix)")
                logFade("voice-middle-\(suffix)", scroll)
                clip.scroll(to: .zero); scroll.reflectScrolledClipView(clip)
                drain(300)
                try shot("voice-many-top-\(suffix)")
                logFade("voice-top-\(suffix)", scroll)
            }
            app.iosVoiceComposer.cancel()
            drain(400)
        }
        // Growth 1 → 2 lines while recording.
        window.appearance = NSAppearance(named: .aqua)
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(500)
        app.voiceInputController.debugApplyPartial(Self.voiceTexts[0].1)
        drain(500)
        let host = try XCTUnwrap(window.contentView)
        func boxHeight() -> CGFloat {
            views(host).compactMap { $0 as? MacComposerVoiceTranscriptView }.first?.enclosingScrollView?.frame.height ?? -1
        }
        var hs: [String] = []
        app.voiceInputController.debugApplyPartial(Self.voiceTexts[1].1)
        for i in 0..<20 { drain(16); hs.append(String(format: "%.1f", boxHeight())); if i == 3 || i == 8 { try shot("voice-growth-\(i)") } }
        try hs.joined(separator: " ").write(to: dir.appendingPathComponent("voice-growth.txt"), atomically: true, encoding: .utf8)
        let values = hs.compactMap(Double.init)
        XCTAssertTrue(values.contains { $0 > 21 && $0 < 53 }, "the recording box must ease when the transcript wraps: \(hs)")
        try fadeLog.write(to: dir.appendingPathComponent("fade-voice.txt"), atomically: true, encoding: .utf8)
        for s in ["light", "dark"] {
            XCTAssertTrue(fadeLog.contains("voice-tail-\(s): top=true bottom=false"), fadeLog)
            XCTAssertTrue(fadeLog.contains("voice-middle-\(s): top=true bottom=true"), fadeLog)
            XCTAssertTrue(fadeLog.contains("voice-top-\(s): top=false bottom=true"), fadeLog)
        }
    }

    /// Typing across the wrap: clear moves above the mic (the text gains its
    /// width), once, and the native editor keeps focus (never rebuilt).
    func testTypingAcrossTheWrapStacksClearAboveTheMic() throws {
        app.sessionStore.setDraft(sid, "")
        drain(300)
        let e = editor
        XCTAssertTrue(window.makeFirstResponder(e))
        let oneLineWidth: CGFloat
        e.insertText("Fix", replacementRange: e.selectedRange()); drain(150)
        oneLineWidth = e.enclosingScrollView!.frame.width
        var widths: [CGFloat] = []
        for ch in " the failing tests in my-app, then run the whole suite again and tell me what broke" {
            e.insertText(String(ch), replacementRange: e.selectedRange())
            drain(15)
            widths.append(e.enclosingScrollView!.frame.width)
        }
        drain(300)
        XCTAssertTrue(editor === e, "the editor must not be rebuilt")
        XCTAssertTrue(window.firstResponder === e, "typing keeps focus")
        XCTAssertGreaterThan(e.enclosingScrollView!.frame.width, oneLineWidth + 60, "wrapped text spans the box (controls in a row below)")
        XCTAssertFalse(zip(widths, widths.dropFirst()).contains { $1 < $0 - 0.5 }, "no flicker: \(widths)")
        try shot("stacked-typing-light")
    }

    /// Dictation while Kraki isn't focused: after every partial the box must
    /// fit the transcript (no text below the box's visible area).
    func testProbeVoiceOverflowWhileUnfocused() throws {
        window.resignKey()
        var log = ""
        let words = (0..<60).map { i in ["请把", "这个", "功能", "接入", "Kraki", "然后", "保留", "原来的", "输入框", "样式"][i % 10] }
        for (mode, keyed) in [("unfocused", false), ("focused", true)] {
            if keyed { window.makeKey() } else { window.resignKey() }
            app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
            drain(500)
            var text = ""
            var bad = 0
            for (i, w) in words.enumerated() {
                text += w
                app.voiceInputController.debugApplyPartial(text)
                drain(i % 7 == 0 ? 5 : 40)   // irregular arrival, like real ASR
                drain(250)
                guard let t = views(window.contentView!).compactMap({ $0 as? MacComposerVoiceTranscriptView }).first,
                      let sv = t.enclosingScrollView else { continue }
                let visible = sv.contentView.bounds
                let lines = t.contentHeight / MacComposerVoiceTranscriptView.lineHeight
                // The tail line must be visible: document bottom inside the viewport.
                let tailHidden = t.frame.height - visible.maxY > 1
                let clipped = t.contentHeight > visible.height + 1 && lines < 3.5   // < 3 lines must fit fully
                if tailHidden || clipped {
                    bad += 1
                    log += "\(mode) i=\(i) lines=\(String(format: "%.1f", lines)) content=\(t.contentHeight) doc=\(t.frame.height) viewport=\(visible.height) originY=\(visible.minY) svFrame=\(sv.frame.height)\n"
                    if bad <= 3 { try shot("overflow-\(mode)-\(i)") }
                }
            }
            log += "\(mode): bad=\(bad)\n"
            app.iosVoiceComposer.cancel(); drain(400)
        }
        try log.write(to: dir.appendingPathComponent("overflow.txt"), atomically: true, encoding: .utf8)
        XCTAssertTrue(log.contains("unfocused: bad=0") && log.contains("focused: bad=0"), log)
    }

    /// Typed text: a width change without typing re-wraps the editor and the
    /// box follows (no stale height, nothing scrolled out of view).
    func testEditorFollowsWidthChangesWithoutTyping() throws {
        app.sessionStore.setDraft(sid, Self.texts[2].1)
        drain(500)
        var log = "", bad = 0
        for w in [640.0, 480, 420, 900, 560, 1100, 640] {
            window.setContentSize(NSSize(width: w, height: 190))
            drain(400)
            let e = editor, sv = e.enclosingScrollView!
            let clip = sv.contentView.bounds
            let fitted = MacComposerScrollableTextInput.fittedHeight(e.string, width: clip.width + 8)
            let wrong = abs(e.frame.width - clip.width) > 1 || (e.frame.height <= clip.height + 1 && clip.minY > 0.5)
                || abs(sv.frame.height - fitted) > 2
            if wrong { bad += 1 }
            log += (wrong ? "BAD " : "ok  ") + "w=\(Int(w)) clip=\(clip.width)x\(clip.height) doc=\(e.frame.size) originY=\(clip.minY) fitted=\(fitted) box=\(sv.frame.height)\n"
        }
        try log.write(to: dir.appendingPathComponent("editor-resize.txt"), atomically: true, encoding: .utf8)
        XCTAssertEqual(bad, 0, log)
    }

    /// Width changes during dictation (window resize, sidebar / inspector):
    /// the transcript must re-wrap to the new width and the box must follow.
    func testProbeVoiceOverflowOnResize() throws {
        var log = ""
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(500)
        app.voiceInputController.debugApplyPartial("请把这个功能接入 Kraki，保留原来的输入框样式，然后再跑一遍测试看看有没有问题")
        drain(500)
        var bad = 0
        for (i, w) in [640.0, 560, 480, 420, 520, 700, 900, 460, 640].enumerated() {
            window.setContentSize(NSSize(width: w, height: 190))
            drain(400)
            guard let t = views(window.contentView!).compactMap({ $0 as? MacComposerVoiceTranscriptView }).first,
                  let sv = t.enclosingScrollView else { continue }
            let visible = sv.contentView.bounds
            let expected = MacComposerVoiceTranscriptView.measure(
                MacComposerVoiceTranscriptOnly.pieces(controller: app.voiceInputController, preview: app.iosVoiceComposer.preview),
                width: visible.width)
            let line = "w=\(Int(w)) clip=\(visible.width) docW=\(t.frame.width) content=\(t.contentHeight) expected=\(expected) viewport=\(visible.height) doc=\(t.frame.height) originY=\(visible.minY)"
            // Short text must fill its document exactly (no stale extra height
            // scrolled out of view), long text must stay pinned to its tail.
            let fits = expected <= visible.height + 1
            let wrong = abs(t.frame.width - visible.width) > 1 || abs(t.contentHeight - expected) > 1
                || (fits && visible.minY > 0.5)
                || (!fits && abs(t.frame.height - visible.maxY) > 1)
            if wrong { bad += 1; try shot("resize-\(i)") }
            log += (wrong ? "BAD " : "ok  ") + line + "\n"
        }
        log += "bad=\(bad)\n"
        try log.write(to: dir.appendingPathComponent("overflow-resize.txt"), atomically: true, encoding: .utf8)
        XCTAssertEqual(bad, 0, log)
    }

    func testStates() throws {
        for (suffix, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            for (name, text) in Self.texts {
                app.sessionStore.setDraft(sid, text)
                drain(700)
                try shot("composer-\(name)-\(suffix)")
                if name != "many-top" { logFade("text-\(name)-\(suffix)", editor.enclosingScrollView) }
            }
            // Many lines, caret at the end: scrolled to the bottom.
            let e = editor
            e.setSelectedRange(NSRange(location: e.string.utf16.count, length: 0))
            e.scrollRangeToVisible(e.selectedRange())
            drain(300)
            try shot("composer-many-bottom-\(suffix)")
            logFade("text-bottom-\(suffix)", e.enclosingScrollView)
            // Scrolled to the middle: content above and below.
            if let clip = e.enclosingScrollView?.contentView {
                clip.scroll(to: NSPoint(x: 0, y: max(0, (e.frame.height - clip.bounds.height) / 2)))
                e.enclosingScrollView?.reflectScrolledClipView(clip)
            }
            drain(300)
            try shot("composer-many-middle-\(suffix)")
            logFade("text-middle-\(suffix)", e.enclosingScrollView)
            if let clip = e.enclosingScrollView?.contentView {
                clip.scroll(to: .zero); e.enclosingScrollView?.reflectScrolledClipView(clip)
            }
            drain(300)
            try shot("composer-many-scrolltop-\(suffix)")
            logFade("text-top-\(suffix)", e.enclosingScrollView)
            app.sessionStore.setDraft(sid, "")
            drain(400)
        }
        try fadeLog.write(to: dir.appendingPathComponent("fade-text.txt"), atomically: true, encoding: .utf8)
        for s in ["light", "dark"] {
            XCTAssertTrue(fadeLog.contains("text-bottom-\(s): top=true bottom=false"), fadeLog)
            for n in ["1-line", "2-lines", "3-lines"] { XCTAssertTrue(fadeLog.contains("text-\(n)-\(s): no fade"), fadeLog) }
            XCTAssertTrue(fadeLog.contains("text-middle-\(s): top=true bottom=true"), fadeLog)
            XCTAssertTrue(fadeLog.contains("text-top-\(s): top=false bottom=true"), fadeLog)
        }
    }

    /// The capsule's height sampled every 16 ms while the draft grows from
    /// one line to two (shows whether it animates or jumps), plus frames.
    func testGrowthFrames() throws {
        window.appearance = NSAppearance(named: .aqua)
        app.sessionStore.setDraft(sid, Self.texts[0].1)
        drain(600)
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        var heights: [CGFloat] = []
        app.sessionStore.setDraft(sid, Self.texts[1].1)
        for i in 0..<25 { drain(16); heights.append(scroll.frame.height); if i == 4 { try shot("growth-mid") } }
        try heights.map { String(format: "%.1f", $0) }.joined(separator: " ")
            .write(to: dir.appendingPathComponent("growth-heights.txt"), atomically: true, encoding: .utf8)
        XCTAssertTrue(heights.contains { $0 > 21 && $0 < 37 }, "1→2 lines must ease, not jump: \(heights)")
        XCTAssertEqual(heights.last ?? 0, 38, accuracy: 0.5)
        app.sessionStore.setDraft(sid, Self.texts[0].1)
        drain(600)
        app.sessionStore.setDraft(sid, Self.texts[1].1)
        for i in 0..<4 { drain(60); try shot("growth-\(i)") }
    }
}
#endif
