#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// The production SwiftUI TextField remains mounted: decoration must preserve
/// its native font, selection, IME and manual-send ownership.
@MainActor final class VoiceDraftNativeTests: XCTestCase {
    func testEditProgressAndSelectionTakeoverInLightAndDark() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            try scenario(style: style, takeover: "selection")
        }
    }
    func testTypingFencesStreamingAndFinal() throws { try scenario(style: .light, takeover: "typing") }
    func testMarkedIMEFencesStreamingBeforeCommit() throws { try scenario(style: .light, takeover: "ime") }

    private func scenario(style: UIUserInterfaceStyle, takeover: String) throws {
        try requireForegroundUITests()
        let driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        let sid = "voice-a"
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: ChatView(sessionId: sid).environment(app))
        window.rootViewController = host; window.makeKeyAndVisible()
        defer {
            app.iosVoiceComposer.retireKeepingDraft(); app.voiceInputController.forgetLease()
            window.isHidden = true; window.rootViewController = nil
        }
        func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
        func waitFor(_ phase: String, file: StaticString = #filePath, line: UInt = #line, _ ready: () -> Bool) {
            let deadline = Date().addingTimeInterval(2)
            while !ready(), Date() < deadline { drain(0.02) }
            XCTAssertTrue(ready(), "native voice phase not ready: \(phase)", file: file, line: line)
        }
        func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("voice-polish")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        func capture(_ phase: String) throws {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try image.pngData()!.write(to: output.appendingPathComponent("ios-\(style == .dark ? "dark" : "light")-\(takeover)-\(phase).png"))
        }
        drain(0.6)
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        waitFor("recording and ASR") {
            app.iosVoiceComposer.isRecording && !app.iosVoiceComposer.preview.spoken.isEmpty
        }
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        try capture("recording")
        app.iosVoiceComposer.finishToDraft()
        waitFor("native Edit field and requested caret") {
            guard let input = all(host.view).compactMap({ $0 as? UITextView }).first(where: \.isEditable) else { return false }
            return input.isFirstResponder && input.text == app.sessionStore.drafts[sid]
                && app.iosVoiceComposer.uncorrectedRange(in: sid) != nil
                && input.selectedRange == app.iosVoiceComposer.selectionRequest
        }
        let editor = try XCTUnwrap(all(host.view).compactMap { $0 as? UITextView }.first(where: \.isEditable),
                                  "production vertical SwiftUI TextField must keep its native UITextView")
        XCTAssertTrue(editor.isFirstResponder)
        XCTAssertFalse(app.iosVoiceComposer.operation?.dirty ?? true, "programmatic focus/selection must not claim human ownership")
        let font = editor.font
        func awaitPendingPresentation(_ range: NSRange) {
            // Binding delivery and the background decorator are separate native
            // run-loop turns. A cold CI keyboard can delay that second turn;
            // wait for presentation rather than assuming 150/500ms is enough.
            // The exact alpha assertion below remains the acceptance condition.
            func alpha() -> CGFloat {
                guard range.location < editor.textStorage.length else { return -1 }
                return (editor.textStorage.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1
            }
            let start = Date(), initial = alpha()
            while abs(alpha() - 0.5) > 0.01, Date().timeIntervalSince(start) < 2 { drain(0.02) }
            let markers = all(host.view).compactMap { $0 as? IOSVoiceDraftDecoration.Marker }
            if abs(initial - 0.5) > 0.01 {
                print("VOICE_PRESENTATION style=\(style.rawValue) initial=\(initial) final=\(alpha()) wait=\(Date().timeIntervalSince(start)) markers=\(markers.count) tracked=\(markers.map { $0.debugTrackedInput === editor }) pending=\(markers.map { String(describing: $0.pending) })")
            }
            XCTAssertTrue(markers.contains { $0.debugTrackedInput === editor }, "decorate the actual native editor only")
        }
        var pending = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: sid))
        awaitPendingPresentation(pending)
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 0.5, accuracy: 0.01)
        try capture("pending")
        // Deterministically outlive the old 150ms sampling delay, as a cold
        // native run loop can. The fake engine still delivers the real event.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            driver.emit(.correctionDelta("请将这个功能接入 Kraki，"))
        }
        waitFor("progressive draft and requested caret") {
            editor.text.hasPrefix("请将这个功能接入 Kraki，")
                && (app.iosVoiceComposer.uncorrectedRange(in: sid)?.location ?? 0) > 0
                && editor.selectedRange == app.iosVoiceComposer.selectionRequest
        }
        XCTAssertTrue(editor === all(host.view).compactMap { $0 as? UITextView }.first(where: \.isEditable))
        XCTAssertFalse(app.iosVoiceComposer.operation?.dirty ?? true)
        pending = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: sid))
        XCTAssertGreaterThan(pending.location, 0)
        XCTAssertTrue(editor.text.hasPrefix("请将这个功能接入 Kraki，"))
        awaitPendingPresentation(pending)
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 1, accuracy: 0.01)
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 0.5, accuracy: 0.01)
        XCTAssertEqual(editor.font, font)
        // SwiftUI can reapply native foreground attributes after the marker's
        // layout callback (for example during initial focus/appearance work).
        // Attribute-only updates must restore tint without claiming ownership.
        let beforeRestyle = editor.selectedRange
        editor.textStorage.addAttribute(.foregroundColor, value: UIColor.label,
                                        range: NSRange(location: 0, length: editor.textStorage.length))
        awaitPendingPresentation(pending)
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 0.5, accuracy: 0.01)
        XCTAssertEqual(editor.selectedRange, beforeRestyle)
        XCTAssertEqual(editor.font, font)
        XCTAssertFalse(app.iosVoiceComposer.operation?.dirty ?? true)
        try capture("progress")
        switch takeover {
        case "typing": editor.insertText(" human")
        case "ime": editor.setMarkedText("正在输入", selectedRange: NSRange(location: 4, length: 0))
        default: editor.selectedRange = NSRange(location: 0, length: 1)
        }
        waitFor("human takeover") { app.iosVoiceComposer.operation?.dirty == true }
        XCTAssertTrue(app.iosVoiceComposer.operation?.dirty == true, takeover)
        XCTAssertNil(app.iosVoiceComposer.uncorrectedRange(in: sid))
        let visible = editor.text, selected = editor.selectedRange
        driver.emit(.correctionDelta("Late replacement")); driver.emit(.final("Late final", rawText: "original"))
        waitFor("late final callback consumed") { app.iosVoiceComposer.operation == nil }
        XCTAssertEqual(editor.text, visible)
        XCTAssertEqual(editor.selectedRange, selected)
        XCTAssertEqual(driver.sentCount, 0, "Edit is always manual-send")
        if takeover == "ime" { XCTAssertNotNil(editor.markedTextRange); editor.unmarkText() }
        waitFor("human-owned text color reset") {
            editor.textStorage.length > 0 && (editor.textStorage.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)?.cgColor.alpha == 1
        }
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 1, accuracy: 0.01)
    }
}
#endif
