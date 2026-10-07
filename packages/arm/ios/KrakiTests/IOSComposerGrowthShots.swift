#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// iOS Composer: typing 1 / 2 / 5+ lines and dictation transcripts, the
/// growth animation, and the scrolled-edge fades. Runs inside the Simulator
/// (headless; never opens Simulator.app). Local: TEST_RUNNER_KRAKI_COMPOSER_SHOTS=1.
@MainActor
final class IOSComposerGrowthShots: XCTestCase {
    private var window: UIWindow!
    private var host: UIHostingController<AnyView>!
    private var app: AppState!
    private var driver: IOSVoiceHoldScenarioDriver!
    private let sid = "voice-a"
    private var log = ""
    private var dir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("composer-shots")
    }

    override func setUp() async throws {
        if ProcessInfo.processInfo.environment["KRAKI_COMPOSER_SHOTS"] != "1" { try requireForegroundUITests() }
        driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try mount(.light)
    }

    /// A fresh window per appearance: Liquid Glass adapts to what is behind
    /// it when shown, so flipping a live window's style left it light-gray.
    private func mount(_ style: UIUserInterfaceStyle) throws {
        window?.isHidden = true; window?.rootViewController = nil
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = style
        host = UIHostingController(rootView: AnyView(
            VStack(spacing: 0) { Spacer(minLength: 0); MessageInputView(sessionId: sid) }
                .background(Color(.systemBackground))
                .environment(app)))
        window.rootViewController = host
        window.makeKeyAndVisible()
        drain(0.6)
    }

    override func tearDown() async throws {
        app?.iosVoiceComposer.discard(); app?.voiceInputController.forgetLease()
        window?.isHidden = true; window?.rootViewController = nil; window = nil
    }

    private func drain(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
    private func all(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(all) }
    private var textView: UITextView? { all(host.view).compactMap { $0 as? UITextView }.first(where: \.isEditable) }
    private var fade: IOSTextFieldEdgeFade.Marker? { all(host.view).compactMap { $0 as? IOSTextFieldEdgeFade.Marker }.first }

    private func shot(_ name: String) throws {
        let bounds = window.bounds
        let crop = CGRect(x: 0, y: bounds.height - 330, width: bounds.width, height: 330)
        let image = UIGraphicsImageRenderer(bounds: crop).image { _ in
            window.drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: dir.appendingPathComponent("\(name).png"))
    }

    /// Height of the glass capsule: the composer's tallest child above the
    /// bottom safe area is what grows; sample the editor / transcript frame.
    private func boxHeight() -> CGFloat {
        if let t = textView { return t.frame.height }
        return -1
    }

    static let texts: [(String, String)] = [
        ("1-line", "Fix the failing tests"),
        ("2-lines", "Fix the failing tests in my-app, then run the suite again"),
        ("5-lines", "Fix the failing tests\nRun the suite again\nKeep the public API\nAdd a regression test\nTell me what broke"),
        ("many", (1...10).map { "Line \($0): one more requirement." }.joined(separator: "\n")),
    ]

    func testTypingStatesAndFades() throws {
        for (style, suffix) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            try mount(style)
            for (name, text) in Self.texts {
                app.sessionStore.setDraft(sid, text)
                drain(0.7)
                try shot("ios-text-\(name)-\(suffix)")
                if let f = fade { log += "text-\(name)-\(suffix): top=\(f.debugEdges.top) bottom=\(f.debugEdges.bottom)\n" }
            }
            let tv = try XCTUnwrap(textView)
            tv.setContentOffset(CGPoint(x: 0, y: max(0, (tv.contentSize.height - tv.bounds.height) / 2)), animated: false)
            drain(0.3)
            try shot("ios-text-many-middle-\(suffix)")
            log += "text-middle-\(suffix): top=\(fade!.debugEdges.top) bottom=\(fade!.debugEdges.bottom)\n"
            tv.setContentOffset(CGPoint(x: 0, y: -tv.adjustedContentInset.top), animated: false)
            drain(0.3)
            try shot("ios-text-many-top-\(suffix)")
            log += "text-top-\(suffix): top=\(fade!.debugEdges.top) bottom=\(fade!.debugEdges.bottom)\n"
            tv.setContentOffset(CGPoint(x: 0, y: tv.contentSize.height - tv.bounds.height + tv.adjustedContentInset.bottom), animated: false)
            drain(0.3)
            try shot("ios-text-many-bottom-\(suffix)")
            log += "text-bottom-\(suffix): top=\(fade!.debugEdges.top) bottom=\(fade!.debugEdges.bottom)\n"
            app.sessionStore.setDraft(sid, "")
            drain(0.4)
        }
        try log.write(to: dir.appendingPathComponent("fade-text.txt"), atomically: true, encoding: .utf8)
        for s in ["light", "dark"] {
            for n in ["1-line", "2-lines", "5-lines"] { XCTAssertTrue(log.contains("text-\(n)-\(s): top=false bottom=false"), log) }
            XCTAssertTrue(log.contains("text-middle-\(s): top=true bottom=true"), log)
            XCTAssertTrue(log.contains("text-top-\(s): top=false bottom=true"), log)
            XCTAssertTrue(log.contains("text-bottom-\(s): top=true bottom=false"), log)
        }
    }

    func testTypingGrowthEases() throws {
        app.sessionStore.setDraft(sid, Self.texts[0].1)
        drain(0.6)
        let tv = try XCTUnwrap(textView)
        let start = tv.frame.height
        var heights: [CGFloat] = []
        app.sessionStore.setDraft(sid, Self.texts[1].1)
        for i in 0..<20 {
            drain(0.016); heights.append(tv.frame.height)
            if i == 4 { try shot("ios-growth-mid") }
        }
        try heights.map { String(format: "%.1f", $0) }.joined(separator: " ")
            .write(to: dir.appendingPathComponent("growth.txt"), atomically: true, encoding: .utf8)
        let end = heights.last ?? 0
        XCTAssertGreaterThan(end, start + 10)
        XCTAssertTrue(heights.contains { $0 > start + 1 && $0 < end - 1 }, "1→2 lines must ease, not jump: \(heights)")
    }

    static let voiceTexts: [(String, String)] = [
        ("1-line", "请把这个功能接入 Kraki"),
        ("2-lines", "请把这个功能接入 Kraki，保留原来的输入框样式，然后再跑一遍测试"),
        ("many", String(repeating: "请把这个功能接入 Kraki，保留原来的输入框样式，然后再跑一遍测试。", count: 8)),
    ]

    private var transcriptScroll: UIScrollView? {
        all(host.view).compactMap { $0 as? UIScrollView }.first { !($0 is UITextView) && $0.contentSize.height > 1 }
    }

    func testVoiceStatesAndFades() throws {
        for (style, suffix) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            try mount(style)
            app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
            drain(0.6)
            XCTAssertTrue(app.iosVoiceComposer.isRecording)
            for (name, text) in Self.voiceTexts {
                app.voiceInputController.debugApplyPartial(text)
                for level: Float in [0.02, 0.08, 0.2, 0.12, 0.05] { driver.emitLevel(level) }
                drain(0.7)
                try shot("ios-voice-\(name)-\(suffix)")
            }
            let scroll = try XCTUnwrap(transcriptScroll)
            XCTAssertGreaterThan(scroll.contentSize.height, scroll.bounds.height, "long dictation scrolls")
            XCTAssertEqual(scroll.contentOffset.y + scroll.bounds.height, scroll.contentSize.height + scroll.adjustedContentInset.bottom,
                           accuracy: 2, "long dictation follows its newest words")
            scroll.setContentOffset(CGPoint(x: 0, y: (scroll.contentSize.height - scroll.bounds.height) / 2), animated: false)
            drain(0.4)
            try shot("ios-voice-many-middle-\(suffix)")
            scroll.setContentOffset(.zero, animated: false)
            drain(0.4)
            try shot("ios-voice-many-top-\(suffix)")
            app.iosVoiceComposer.cancel()
            drain(0.5)
        }
        // The transcript row fits two lines; growing past them eases.
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(0.6)
        app.voiceInputController.debugApplyPartial(Self.voiceTexts[1].1)
        drain(0.6)
        let scroll = try XCTUnwrap(transcriptScroll)
        let start = scroll.frame.height
        var hs: [CGFloat] = []
        app.voiceInputController.debugApplyPartial(Self.voiceTexts[2].1)
        for i in 0..<20 { drain(0.016); hs.append(scroll.frame.height); if i == 4 { try shot("ios-voice-growth-mid") } }
        try hs.map { String(format: "%.1f", $0) }.joined(separator: " ")
            .write(to: dir.appendingPathComponent("voice-growth.txt"), atomically: true, encoding: .utf8)
        let end = hs.last ?? 0
        XCTAssertGreaterThan(end, start + 10)
        XCTAssertTrue(hs.contains { $0 > start + 1 && $0 < end - 1 }, "transcript growth must ease: \(hs)")
        XCTAssertEqual(scroll.contentOffset.y + scroll.bounds.height, scroll.contentSize.height + scroll.adjustedContentInset.bottom,
                       accuracy: 2, "the newest words stay in view")
    }
}
#endif
