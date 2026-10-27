#if os(macOS) && DEBUG
import AppKit
import ObjectiveC
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Layout regressions of the Mac composer editor, driven through the
/// production `MacChatComposer`: the per-keystroke measurement cost and the
/// scroll position of long drafts, the one-row → two-row switch, and the
/// document height while the box animates. Off-screen borderless windows
/// that are key only inside this inactive test app; no events are posted to
/// the system.
@MainActor
final class MacComposerLayoutRegressionTests: XCTestCase {
    private final class KeyableWindow: NSWindow {
        override var canBecomeKey: Bool { true }
        override var isKeyWindow: Bool { true }
    }

    private var window: NSWindow?

    override func setUpWithError() throws { try requireForegroundUITests() }

    override func tearDown() {
        TextKitLayoutCounter.stop()
        MacComposerMetrics.snapshotFlatGlass = false
        window?.orderOut(nil); window?.contentView = nil; window = nil
        super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }
    private func editor(in window: NSWindow) throws -> MacComposerTextView {
        try XCTUnwrap(views(try XCTUnwrap(window.contentView)).compactMap { $0 as? MacComposerTextView }.first)
    }
    private func type(_ text: String, into editor: NSTextView) {
        editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
    }

    private func makeChatComposer(width: CGFloat = 640) -> (NSWindow, AppState) {
        MacComposerMetrics.snapshotFlatGlass = true
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        let window = KeyableWindow(contentRect: NSRect(x: -6000, y: -6000, width: width, height: 220),
                                   styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        self.window = window
        let root = VStack(spacing: 0) { Spacer(minLength: 0); MacChatComposer(sessionId: "voice-a") }
            .frame(maxWidth: .infinity, maxHeight: .infinity).environment(app)
        window.contentView = NSHostingView(rootView: root)
        window.orderFrontRegardless(); window.makeKey()
        drain(500)
        return (window, app)
    }

    /// Log-like text with line breaks, as pasted from a terminal.
    private static func longDraft(_ length: Int) -> String {
        let line = "2026-05-01 12:00:00 INFO pipeline step finished with status ok and some details\n"
        return String(String(repeating: line, count: length / line.count + 1).prefix(length))
    }

    private struct Geometry {
        let clip: CGRect
        let document: CGFloat
        let fadesTop: Bool
        let fadesBottom: Bool
        var overflow: CGFloat { document - clip.height }
        var description: String {
            "clip=\(clip.minY)..\(clip.maxY) doc=\(document) top=\(fadesTop) bottom=\(fadesBottom)"
        }
    }

    private func geometry(of editor: NSTextView) throws -> Geometry {
        let scroll = try XCTUnwrap(editor.enclosingScrollView as? MacEdgeFadingScrollView)
        return Geometry(clip: scroll.contentView.bounds, document: editor.frame.height,
                        fadesTop: scroll.edgeFade?.fadesTop ?? false, fadesBottom: scroll.edgeFade?.fadesBottom ?? false)
    }

    /// The editor's text height laid out independently: TextKit 1, the
    /// editor's font, insets (4 × 1 pt) and line fragment padding (0).
    private static func independentHeight(_ text: String, editorWidth: CGFloat) -> (height: CGFloat, lines: Int) {
        let storage = NSTextStorage(string: text.isEmpty ? " " : text, attributes: [.font: NSFont.systemFont(ofSize: 15)])
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: max(1, editorWidth - 8), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        var lines = 0
        layout.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: layout.numberOfGlyphs)) { _, _, _, _, _ in
            lines += 1
        }
        if !layout.extraLineFragmentRect.isEmpty { lines += 1 }
        let used = max(layout.usedRect(for: container).maxY, layout.extraLineFragmentRect.maxY)
        return (ceil(used) + 2, lines)
    }

    // MARK: Long drafts (finding 4)

    /// Each keystroke in a 5,000-character draft used to lay out the whole
    /// draft 31–57 times (every SwiftUI pass re-measured it from scratch).
    /// Measurements outside the editor's own text system are counted: those
    /// that laid out the whole draft, and all of them (a measurement may stop
    /// at the box's cap; SwiftUI also probes other widths).
    func testLongDraftKeystrokeMeasuresTheDraftAtMostThreeTimes() throws {
        let (window, app) = makeChatComposer()
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        app.sessionStore.setDraft("voice-a", Self.longDraft(5_000)); drain(500)
        editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0)); drain(200)

        var wholeDraft: [Int] = []
        var all: [Int] = []
        for key in ["x", "y", "z"] {
            TextKitLayoutCounter.start(excluding: editor.textStorage)
            type(key, into: editor)
            drain(300)
            all.append(TextKitLayoutCounter.stop())
            wholeDraft.append(TextKitLayoutCounter.wholeTextLayouts)
            print("LAYOUT measured container widths: \(TextKitLayoutCounter.widths)")
        }
        print("LAYOUT measurements per keystroke at 5000 chars: whole draft \(wholeDraft), all \(all)")
        XCTAssertEqual(app.sessionStore.drafts["voice-a"]?.hasSuffix("xyz"), true)
        for index in all.indices {
            XCTAssertLessThanOrEqual(wholeDraft[index], 3, "one keystroke laid out the whole draft \(wholeDraft[index]) times")
            // Each distinct width SwiftUI asks for once; repeats are memoized.
            XCTAssertLessThanOrEqual(all[index], 6, "one keystroke measured the draft \(all[index]) times")
        }
    }

    /// Caret at the end of a 5,000-character draft: the last line sits at the
    /// bottom of the box, with no blank row below it and no bottom fade. The
    /// document height is the editor's real text height and does not flip.
    func testLongDraftWithTheCaretAtTheEndSettlesAtTheBottom() throws {
        let (window, app) = makeChatComposer()
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        app.sessionStore.setDraft("voice-a", Self.longDraft(5_000)); drain(500)
        editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
        editor.scrollRangeToVisible(editor.selectedRange())
        drain(300)
        var documentHeights = Set<CGFloat>()
        for key in ["a", "b", "c", "d"] {
            type(key, into: editor)
            for _ in 0..<12 { drain(16); documentHeights.insert(editor.frame.height) }
        }
        drain(300)
        let settled = try geometry(of: editor)
        let expected = Self.independentHeight(editor.string, editorWidth: editor.frame.width).height
        print("LAYOUT long draft settled \(settled.description) expectedDoc=\(expected) heightsSeen=\(documentHeights.sorted())")
        XCTAssertEqual(settled.document, expected, accuracy: 0.01, "the document is not the text's height")
        XCTAssertEqual(documentHeights.count, 1, "the document height flipped while typing: \(documentHeights.sorted())")
        XCTAssertEqual(settled.clip.maxY, settled.document, accuracy: 0.01,
                       "the caret's last line is not at the bottom of the box: \(settled.description)")
        XCTAssertFalse(settled.fadesBottom, "false bottom fade under the last line: \(settled.description)")
        XCTAssertTrue(settled.fadesTop, "the earlier lines are hidden above: \(settled.description)")
        let caret = editor.firstRect(forCharacterRange: editor.selectedRange(), actualRange: nil)
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        let viewport = window.convertToScreen(scroll.convert(scroll.bounds, to: nil))
        XCTAssertTrue(caret.minY >= viewport.minY - 0.5 && caret.maxY <= viewport.maxY + 0.5,
                      "the caret line is not visible: caret=\(caret) viewport=\(viewport)")
    }

    /// Per-keystroke cost by draft length (Debug build, host). Measurement
    /// only: set TEST_RUNNER_KRAKI_COMPOSER_PERF=1.
    func testKeystrokeCostByDraftLength() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["KRAKI_COMPOSER_PERF"] == "1", "measurement only")
        let (window, app) = makeChatComposer()
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        for size in [100, 5_000, 20_000] {
            app.sessionStore.setDraft("voice-a", Self.longDraft(size)); drain(500)
            editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0)); drain(200)
            var samples: [Double] = []
            for index in 0..<15 {
                let start = CFAbsoluteTimeGetCurrent()
                type(index % 2 == 0 ? "x" : "y", into: editor)
                window.contentView?.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date())
                samples.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
                drain(30)
            }
            samples.sort()
            print(String(format: "PERF keystroke chars=%d median=%.1fms max=%.1fms",
                         size, samples[samples.count / 2], samples.last ?? 0))
        }
    }

    // MARK: One row until the text wraps (finding 8)

    /// The resting composer keeps one row while the draft fits on one line
    /// in the one-row editor, and stacks as soon as it wraps there. Before,
    /// it stacked about 9 pt early (trailing padding counted twice).
    func testOneRowLayoutIsKeptUntilTheTextWraps() throws {
        let sentence = "Fix the failing tests in my-app, then run the whole suite again and tell me what broke please now and later"
        for width in [640, 557] as [CGFloat] {
            let (window, app) = makeChatComposer(width: width)
            let editor = try editor(in: window)
            XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
            type("Fix", into: editor); drain(300)
            let scroll = try XCTUnwrap(editor.enclosingScrollView)
            let oneRowWidth = scroll.frame.width
            let oneRowMinX = scroll.convert(scroll.bounds, to: nil).minX
            var stackedAt: Int?
            var wrapsAt: Int?
            var mismatches: [String] = []
            for (index, character) in sentence.dropFirst(3).enumerated() {
                type(String(character), into: editor)
                // Near the wrap, let the (animated) layout change settle.
                let lookahead = editor.string + sentence.dropFirst(3 + index + 1).prefix(6)
                let nearWrap = Self.independentHeight(lookahead, editorWidth: oneRowWidth).lines > 1
                drain(nearWrap ? 260 : 30)
                let text = editor.string
                let wraps = Self.independentHeight(text, editorWidth: oneRowWidth).lines > 1
                let stacked = scroll.convert(scroll.bounds, to: nil).minX < oneRowMinX - 10
                if wraps, wrapsAt == nil { wrapsAt = text.count }
                if stacked, stackedAt == nil { stackedAt = text.count }
                if wraps != stacked { mismatches.append("len=\(text.count) wraps=\(wraps) stacked=\(stacked)") }
                if wraps, stacked, text.count > (wrapsAt ?? 0) + 3 { break }
            }
            print("LAYOUT window=\(width) oneRowEditor=\(oneRowWidth) wrapsAt=\(wrapsAt ?? -1) stackedAt=\(stackedAt ?? -1)")
            XCTAssertNotNil(wrapsAt, "precondition: the sentence wraps at \(width)")
            XCTAssertEqual(stackedAt, wrapsAt, "window \(width): stacked at \(stackedAt ?? -1), text wraps at \(wrapsAt ?? -1)")
            XCTAssertEqual(mismatches, [], "window \(width)")
            XCTAssertEqual(app.sessionStore.drafts["voice-a"], editor.string)
            window.orderOut(nil); window.contentView = nil
        }
    }

    // MARK: Grow / shrink animation (finding 9)

    /// 1 → 5 lines and back, sampled every 16 ms. While the text fits the
    /// box once settled (≤ 3 lines) no edge fades, also mid-animation; when
    /// settled, the document is exactly the clip's height (or, beyond three
    /// lines, the caret's last line ends exactly at the clip's bottom).
    func testGrowAndShrinkSettleWithAnExactFit() throws {
        let (window, app) = makeChatComposer(width: 640)
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        let lineHeight = MacComposerScrollableTextInput.height(lines: 2) - MacComposerScrollableTextInput.height(lines: 1)
        let cap = MacComposerScrollableTextInput.height(lines: MacComposerMetrics.maxVisibleTextLines)
        var transientFades: [String] = []
        var settledProblems: [String] = []
        var maxTransientOverflow: CGFloat = 0
        var overflowByStep: [String] = []
        func sample(_ label: String, lines: Int) throws {
            var stepOverflow: CGFloat = 0
            defer { overflowByStep.append("\(label)=\(stepOverflow)") }
            let fits = MacComposerScrollableTextInput.height(lines: CGFloat(lines)) <= cap + 0.5
            var last: Geometry?
            for index in 0..<24 {
                drain(16)
                let state = try geometry(of: editor)
                stepOverflow = max(stepOverflow, state.overflow)
                if fits { maxTransientOverflow = max(maxTransientOverflow, state.overflow) }
                if fits, state.fadesTop || state.fadesBottom {
                    transientFades.append("\(label) t=\(index * 16)ms \(state.description)")
                }
                last = state
            }
            guard let settled = last else { return }
            let expectedDoc = MacComposerScrollableTextInput.height(lines: CGFloat(lines))
            if abs(settled.document - expectedDoc) > 0.01 { settledProblems.append("\(label) doc \(settled.description) expected \(expectedDoc)") }
            if fits {
                if abs(settled.overflow) > 0.01 || abs(settled.clip.minY) > 0.01 {
                    settledProblems.append("\(label) not an exact fit: \(settled.description)")
                }
            } else {
                if abs(settled.clip.height - cap) > 0.01 || abs(settled.clip.maxY - settled.document) > 0.01
                    || settled.fadesBottom || !settled.fadesTop {
                    settledProblems.append("\(label) scrolled box: \(settled.description)")
                }
            }
        }
        let lines = ["Line one of the draft", "Line two of the draft", "Line three of the draft",
                     "Line four of the draft", "Line five of the draft"]
        for (index, line) in lines.enumerated() {
            if index > 0 { editor.insertNewlineIgnoringFieldEditor(nil) }
            type(line, into: editor)
            try sample("grow\(index + 1)", lines: index + 1)
        }
        for count in (1..<lines.count).reversed() {
            let text = editor.string as NSString
            let newline = text.range(of: "\n", options: .backwards)
            editor.setSelectedRange(NSRange(location: newline.location, length: text.length - newline.location))
            editor.deleteBackward(nil)
            try sample("shrink\(count)", lines: count)
        }
        editor.selectAll(nil); editor.deleteBackward(nil)
        try sample("empty", lines: 1)
        print("LAYOUT grow/shrink maxTransientOverflow=\(maxTransientOverflow) lineHeight=\(lineHeight) transientFades=\(transientFades.count)")
        print("LAYOUT grow/shrink transient overflow (document − clip) by step: \(overflowByStep.joined(separator: " "))")
        transientFades.prefix(20).forEach { print("LAYOUT transient fade \($0)") }
        settledProblems.forEach { print("LAYOUT settled problem \($0)") }
        XCTAssertEqual(settledProblems, [])
        XCTAssertEqual(transientFades, [], "edge fades over text that fits the box once settled")
        XCTAssertEqual(app.sessionStore.drafts["voice-a"] ?? "", "")
    }

    /// CJK, emoji (fallback fonts with their own line heights) and mixed
    /// drafts: the box, the document and the editor's layout agree exactly.
    func testCJKAndEmojiDraftsSettleWithAnExactFit() throws {
        let (window, app) = makeChatComposer(width: 640)
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        let drafts = ["中文输入法试一下", "emoji 👩‍👩‍👧 done 🎉",
                      "中文混排测试一下换行位置 emoji 👩‍👩‍👧 mixed with English words that wrap onto a second line here",
                      "第一行\n第二行 👍\n第三行"]
        for draft in drafts {
            app.sessionStore.setDraft("voice-a", ""); drain(200)
            type(draft, into: editor); drain(400)
            let state = try geometry(of: editor)
            let expected = Self.independentHeight(editor.string, editorWidth: editor.frame.width).height
            XCTAssertEqual(state.document, expected, accuracy: 0.01, "\(draft): \(state.description)")
            XCTAssertEqual(state.clip.height, state.document, accuracy: 0.01, "\(draft): \(state.description)")
            XCTAssertEqual(state.clip.minY, 0, accuracy: 0.01, "\(draft): \(state.description)")
            XCTAssertFalse(state.fadesTop || state.fadesBottom, "\(draft): \(state.description)")
            XCTAssertEqual(app.sessionStore.drafts["voice-a"], draft)
        }
    }

    /// The new-session composer shares the editor (3 to 10 lines): beyond
    /// ten lines the caret's line ends at the clip's bottom; back to one
    /// line, the document is exactly the three-line box.
    func testNewSessionComposerSettlesWithAnExactFit() throws {
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        let window = KeyableWindow(contentRect: NSRect(x: -6000, y: -6000, width: 820, height: 520),
                                   styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        self.window = window
        window.contentView = NSHostingView(rootView: MacStartSessionView(firstTime: false)
            .environment(app).environment(TentacleCLIManager()))
        window.orderFrontRegardless(); window.makeKey()
        drain(600)
        let editor = try editor(in: window)
        XCTAssertTrue(window.makeFirstResponder(editor)); drain(100)
        for index in 1...12 {
            if index > 1 { editor.insertNewlineIgnoringFieldEditor(nil) }
            type("Line \(index) of the task", into: editor); drain(60)
        }
        drain(400)
        let tall = try geometry(of: editor)
        XCTAssertEqual(tall.document, MacComposerScrollableTextInput.height(lines: 12), accuracy: 0.01, tall.description)
        XCTAssertEqual(tall.clip.height, MacComposerScrollableTextInput.height(lines: 10), accuracy: 0.01, tall.description)
        XCTAssertEqual(tall.clip.maxY, tall.document, accuracy: 0.01, tall.description)
        XCTAssertTrue(tall.fadesTop && !tall.fadesBottom, tall.description)

        let text = editor.string as NSString
        let firstLineEnd = text.range(of: "\n").location
        editor.setSelectedRange(NSRange(location: firstLineEnd, length: text.length - firstLineEnd))
        editor.deleteBackward(nil)
        drain(400)
        let short = try geometry(of: editor)
        XCTAssertEqual(short.clip.height, MacComposerScrollableTextInput.height(lines: 3), accuracy: 0.01, short.description)
        XCTAssertEqual(short.document, short.clip.height, accuracy: 0.01, short.description)
        XCTAssertEqual(short.clip.minY, 0, accuracy: 0.01, short.description)
        XCTAssertFalse(short.fadesTop || short.fadesBottom, short.description)
    }
}

/// Counts TextKit 1 layout passes (`ensureLayout(for:)` and
/// `ensureLayout(forBoundingRect:in:)`) of layout managers outside the
/// editor's own text system, i.e. the composer's height measurements.
@MainActor
private enum TextKitLayoutCounter {
    static var count = 0
    /// Of `count`: layouts that reached the end of the text.
    static var wholeTextLayouts = 0
    static var widths: [CGFloat] = []
    static weak var excludedStorage: NSTextStorage?
    private static var installed = false
    private static let pairs: [(String, Selector)] = [
        ("ensureLayoutForTextContainer:", #selector(NSLayoutManager.krakiTestCountingEnsureLayout(forTextContainer:))),
        ("ensureLayoutForBoundingRect:inTextContainer:",
         #selector(NSLayoutManager.krakiTestCountingEnsureLayout(forBoundingRect:inTextContainer:))),
    ]

    static func start(excluding storage: NSTextStorage?) {
        excludedStorage = storage
        count = 0
        wholeTextLayouts = 0
        widths = []
        if !installed { exchange(); installed = true }
    }

    @discardableResult
    static func stop() -> Int {
        if installed { exchange(); installed = false }
        return count
    }

    /// After the original layout call.
    nonisolated static func note(_ layoutManager: NSLayoutManager) {
        MainActor.assumeIsolated {
            if let excludedStorage, layoutManager.textStorage === excludedStorage { return }
            count += 1
            if layoutManager.firstUnlaidCharacterIndex() >= (layoutManager.textStorage?.length ?? 0) { wholeTextLayouts += 1 }
            widths.append(layoutManager.textContainers.first?.size.width ?? -1)
        }
    }

    private static func exchange() {
        for (original, counting) in pairs {
            guard let a = class_getInstanceMethod(NSLayoutManager.self, NSSelectorFromString(original)),
                  let b = class_getInstanceMethod(NSLayoutManager.self, counting) else { continue }
            method_exchangeImplementations(a, b)
        }
    }
}

extension NSLayoutManager {
    @objc fileprivate func krakiTestCountingEnsureLayout(forTextContainer container: NSTextContainer) {
        krakiTestCountingEnsureLayout(forTextContainer: container) // the original, after the exchange
        TextKitLayoutCounter.note(self)
    }

    @objc fileprivate func krakiTestCountingEnsureLayout(forBoundingRect rect: NSRect, inTextContainer container: NSTextContainer) {
        krakiTestCountingEnsureLayout(forBoundingRect: rect, inTextContainer: container)
        TextKitLayoutCounter.note(self)
    }
}
#endif
