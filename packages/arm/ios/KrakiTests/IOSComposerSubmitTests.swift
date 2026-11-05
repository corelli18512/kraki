#if os(iOS)
import XCTest
import SwiftUI
import UIKit
import Darwin
@testable import Kraki

/// What the iPhone composer submits and shows around a submission: Return on
/// an empty draft (K-154), Stop right after Send (K-151) and a staged image
/// while the agent runs (K-152). Mounts the production `MessageInputView`
/// with an isolated store; nothing leaves the process.
@MainActor final class IOSComposerSubmitTests: XCTestCase {
    private let sessionId = "voice-a"
    private var window: UIWindow?
    private var app: AppState?
    private var host: UIHostingController<AnyView>?
    private var driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false)
    /// Attachment counts and delivery of every `send_input`, in order.
    private var sentAttachments: [Int] = []
    private var sentDelivery: [String] = []

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
        try Self.setApplicationAccessibility(true)
    }

    override func tearDown() {
        try? Self.setApplicationAccessibility(false)
        window?.isHidden = true; window?.rootViewController = nil
        window = nil; app = nil; host = nil
        super.tearDown()
    }

    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    @discardableResult
    private func drain(until condition: () -> Bool, timeout: Double = 3) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { drain(0.02) }
        return condition()
    }
    private func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
    private func editor() -> UITextView? {
        guard let view = host?.view else { return nil }
        return all(view).compactMap { $0 as? UITextView }.first(where: \.isEditable)
    }

    /// SwiftUI builds its buttons' accessibility elements only while
    /// accessibility is on for the app (as in IOSComposerStagedImageTests).
    private static func setApplicationAccessibility(_ enabled: Bool) throws {
        let library = try XCTUnwrap(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW), "libAccessibility")
        let symbol = try XCTUnwrap(dlsym(library, "_AXSApplicationAccessibilitySetEnabled"))
        typealias SetEnabled = @convention(c) (Bool) -> Void
        unsafeBitCast(symbol, to: SetEnabled.self)(enabled)
    }

    private func accessible(_ label: String) -> [NSObject] {
        var out: [NSObject] = []
        func walk(_ object: NSObject) {
            if object.accessibilityLabel == label { out.append(object) }
            var kids: [NSObject] = (object as? UIView)?.subviews ?? []
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 { kids += (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject } }
            kids.forEach(walk)
        }
        if let window { walk(window) }
        return out
    }

    private func show(state: SessionState = .idle) throws -> AppState {
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        let fixtureHandler = app.testOutboundMessageHandler
        app.testOutboundMessageHandler = { [weak self] message, target, scoped in
            if message["type"] as? String == "send_input", let payload = message["payload"] as? [String: Any] {
                self?.sentAttachments.append((payload["attachments"] as? [Any])?.count ?? 0)
                self?.sentDelivery.append(payload["delivery"] as? String ?? "prompt")
            }
            return fixtureHandler?(message, target, scoped) ?? true
        }
        app.sessionStore.sessions[sessionId]?.state = state
        self.app = app
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: AnyView(MessageInputView(sessionId: sessionId).environment(app)))
        window?.rootViewController = host
        window?.makeKeyAndVisible()
        self.host = host
        XCTAssertTrue(drain(until: { self.editor() != nil }), "the composer is shown")
        drain(0.2)
        return app
    }

    private func stageImage(_ app: AppState) throws -> StagedComposerImage {
        let png = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }.pngData())
        let image = StagedComposerImage(data: png, mimeType: "image/png")
        app.sessionStore.setStagedImage(sessionId, image)
        return image
    }

    // MARK: K-154

    /// Return on an empty or whitespace-only draft sends nothing and must not
    /// leave the newline in the field (the field used to keep growing).
    func testReturnOnEmptyOrWhitespaceDraftLeavesNoNewline() throws {
        let app = try show()
        let field = try XCTUnwrap(editor())
        field.becomeFirstResponder()
        field.insertText("\n")
        drain(0.3)
        XCTAssertEqual(sentAttachments.count, 0, "nothing to send")
        XCTAssertEqual(editor()?.text ?? "", "", "the Return newline is not left in an empty field")

        field.insertText("  ")
        XCTAssertTrue(drain(until: { app.sessionStore.drafts[self.sessionId] == "  " }))
        XCTAssertTrue(drain(until: { !self.accessible("Clear message").isEmpty }), "a whitespace draft can be cleared")
        field.insertText("\n")
        drain(0.3)
        XCTAssertEqual(sentAttachments.count, 0)
        XCTAssertEqual(editor()?.text, "  ", "Return on whitespace keeps the draft without the newline")
        XCTAssertEqual(app.sessionStore.drafts[sessionId], "  ")
    }

    // MARK: K-151

    /// Send turns into Stop as soon as the field empties while the agent
    /// runs: a second tap right after Send must not stop the turn just steered.
    func testStopRightAfterSendIsIgnored() throws {
        _ = try show(state: .active)
        let field = try XCTUnwrap(editor())
        field.becomeFirstResponder()
        field.insertText("keep going")
        XCTAssertTrue(drain(until: { self.app?.sessionStore.drafts[self.sessionId] == "keep going" }))
        field.insertText("\n")
        XCTAssertTrue(drain(until: { self.sentDelivery == ["steer"] }), "Return steered the running turn")
        XCTAssertTrue(drain(until: { !self.accessible("Stop agent").isEmpty }, timeout: 1), "Stop replaces Send")
        XCTAssertTrue(accessible("Stop agent").first?.accessibilityActivate() ?? false)
        drain(0.1)
        XCTAssertEqual(driver.aborts, 0, "a tap right after Send does not stop the turn")

        drain(0.8)
        XCTAssertTrue(accessible("Stop agent").first?.accessibilityActivate() ?? false)
        XCTAssertTrue(drain(until: { self.driver.aborts == 1 }), "a deliberate Stop still works")
    }

    // MARK: K-152

    /// Images are attached only while the agent is idle. A steer typed while
    /// it runs carries no image staged earlier: the image stays for the next
    /// prompt, and with only an image staged the button is Stop.
    func testSteerLeavesTheStagedImageForTheNextPrompt() throws {
        let app = try show(state: .active)
        let image = try stageImage(app)
        drain(0.2)
        XCTAssertFalse(accessible("Stop agent").isEmpty, "an image alone cannot steer: the button stays Stop")

        let field = try XCTUnwrap(editor())
        field.becomeFirstResponder()
        field.insertText("look again")
        XCTAssertTrue(drain(until: { app.sessionStore.drafts[self.sessionId] == "look again" }))
        field.insertText("\n")
        XCTAssertTrue(drain(until: { self.sentDelivery.count == 1 }))
        XCTAssertEqual(sentDelivery, ["steer"])
        XCTAssertEqual(sentAttachments, [0], "the steer carries no image")
        XCTAssertEqual(app.sessionStore.stagedImages[sessionId], image, "the image stays staged")

        app.sessionStore.sessions[sessionId]?.state = .idle
        drain(0.3)
        field.insertText("now with it")
        XCTAssertTrue(drain(until: { app.sessionStore.drafts[self.sessionId] == "now with it" }))
        field.insertText("\n")
        XCTAssertTrue(drain(until: { self.sentDelivery.count == 2 }))
        XCTAssertEqual(sentDelivery, ["steer", "prompt"])
        XCTAssertEqual(sentAttachments, [0, 1], "the next prompt carries the image")
        XCTAssertNil(app.sessionStore.stagedImages[sessionId])
    }
}
#endif
