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
        drain(0.4)
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        try capture("recording")
        app.iosVoiceComposer.finishToDraft()
        drain(0.5)
        let editor = try XCTUnwrap(all(host.view).compactMap { $0 as? UITextView }.first(where: \.isEditable),
                                  "production vertical SwiftUI TextField must keep its native UITextView")
        XCTAssertTrue(editor.isFirstResponder)
        XCTAssertFalse(app.iosVoiceComposer.operation?.dirty ?? true, "programmatic focus/selection must not claim human ownership")
        let font = editor.font
        var pending = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: sid))
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 0.5, accuracy: 0.01)
        try capture("pending")
        driver.emit(.correctionDelta("请将这个功能接入 Kraki，")); drain(0.15)
        XCTAssertTrue(editor === all(host.view).compactMap { $0 as? UITextView }.first(where: \.isEditable))
        XCTAssertFalse(app.iosVoiceComposer.operation?.dirty ?? true)
        pending = try XCTUnwrap(app.iosVoiceComposer.uncorrectedRange(in: sid))
        XCTAssertGreaterThan(pending.location, 0)
        XCTAssertTrue(editor.text.hasPrefix("请将这个功能接入 Kraki，"))
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 1, accuracy: 0.01)
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 0.5, accuracy: 0.01)
        XCTAssertEqual(editor.font, font)
        // SwiftUI can reapply native foreground attributes after the marker's
        // layout callback (for example during initial focus/appearance work).
        // Attribute-only updates must restore tint without claiming ownership.
        let beforeRestyle = editor.selectedRange
        editor.textStorage.addAttribute(.foregroundColor, value: UIColor.label,
                                        range: NSRange(location: 0, length: editor.textStorage.length))
        drain(0.2)
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
        drain(0.12)
        XCTAssertTrue(app.iosVoiceComposer.operation?.dirty == true, takeover)
        XCTAssertNil(app.iosVoiceComposer.uncorrectedRange(in: sid))
        let visible = editor.text, selected = editor.selectedRange
        driver.emit(.correctionDelta("Late replacement")); driver.emit(.final("Late final", rawText: "original"))
        drain(0.2)
        XCTAssertEqual(editor.text, visible)
        XCTAssertEqual(editor.selectedRange, selected)
        XCTAssertEqual(driver.sentCount, 0, "Edit is always manual-send")
        if takeover == "ime" { XCTAssertNotNil(editor.markedTextRange); editor.unmarkText() }
        drain(0.1)
        XCTAssertEqual((editor.textStorage.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? -1, 1, accuracy: 0.01)
    }
}
#endif
