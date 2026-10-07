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
