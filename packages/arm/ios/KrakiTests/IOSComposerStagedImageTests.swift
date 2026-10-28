#if os(iOS)
import XCTest
import SwiftUI
import UIKit
import Darwin
@testable import Kraki

/// The iPhone composer keeps its staged image per Session in
/// `SessionStore.stagedImages`, like the draft. It used to live in the
/// composer's view state, so navigating away from a Session and back lost it
/// while the text draft survived. Each `show` mounts a fresh composer, as
/// opening a Session's chat does.
@MainActor final class IOSComposerStagedImageTests: XCTestCase {
    private let sessionA = "voice-a"
    private let sessionB = "voice-b"
    private var window: UIWindow?
    private var app: AppState?
    private var host: UIHostingController<AnyView>?
    /// Attachment counts of every `send_input`, in order.
    private var sentAttachments: [Int] = []
    private var sentTexts: [String] = []
    private var sentAnswerTo: [String?] = []

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
        try Self.setApplicationAccessibility(true)
    }

    override func tearDown() {
        try? Self.setApplicationAccessibility(false)
        app?.iosVoiceComposer.retireKeepingDraft(); app?.voiceInputController.forgetLease()
        window?.isHidden = true; window?.rootViewController = nil
        window = nil; app = nil; host = nil
        super.tearDown()
    }

    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    @discardableResult
    private func drain(until condition: () -> Bool, timeout: Double = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { drain(0.02) }
        return condition()
    }
    private func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
    private func editor() -> UITextView? {
        guard let view = host?.view else { return nil }
        return all(view).compactMap { $0 as? UITextView }.first(where: \.isEditable)
    }

    /// SwiftUI builds the accessibility elements of its buttons (used here to
    /// press them) only while accessibility is on for the app. Turned on for
    /// these tests only, as accessibility snapshot tools do.
    private static func setApplicationAccessibility(_ enabled: Bool) throws {
        let library = try XCTUnwrap(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW), "libAccessibility")
        let symbol = try XCTUnwrap(dlsym(library, "_AXSApplicationAccessibilitySetEnabled"))
        typealias SetEnabled = @convention(c) (Bool) -> Void
        unsafeBitCast(symbol, to: SetEnabled.self)(enabled)
    }

    /// Accessibility elements (SwiftUI buttons) with this label.
    private func accessible(_ label: String) -> [NSObject] {
        var out: [NSObject] = []
        func walk(_ object: NSObject) {
            if object.accessibilityLabel == label {
                out.append(object)
            }
            var kids: [NSObject] = (object as? UIView)?.subviews ?? []
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 { kids += (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject } }
            kids.forEach(walk)
        }
        if let window { walk(window) }
        return out
    }

    private func activate(_ label: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let element = try XCTUnwrap(accessible(label).first, "no \(label) control", file: file, line: line)
        XCTAssertTrue(element.accessibilityActivate(), "\(label) did not activate", file: file, line: line)
        drain(0.2)
    }

    private func makeApp(driver: IOSVoiceHoldScenarioDriver = IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        -> AppState {
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: driver)
        let fixtureHandler = app.testOutboundMessageHandler
        app.testOutboundMessageHandler = { [weak self] message, target, scoped in
            if message["type"] as? String == "send_input", let payload = message["payload"] as? [String: Any] {
                self?.sentAttachments.append((payload["attachments"] as? [Any])?.count ?? 0)
                self?.sentTexts.append(payload["text"] as? String ?? "")
                self?.sentAnswerTo.append(payload["answerTo"] as? String)
            }
            return fixtureHandler?(message, target, scoped) ?? true
        }
        self.app = app
        return app
    }

    /// Opens a Session's composer in a fresh view, dropping the previous one.
    private func show(_ sessionId: String, question: PendingQuestion? = nil) throws {
        let app = try XCTUnwrap(app)
        if window == nil {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            window = UIWindow(windowScene: scene)
        }
        app.sessionStore.activeSessionId = sessionId
        let host = UIHostingController(rootView: AnyView(
            MessageInputView(sessionId: sessionId, pendingQuestion: question).environment(app)))
        window?.rootViewController = host
        window?.makeKeyAndVisible()
        self.host = host
        XCTAssertTrue(drain(until: { self.editor() != nil }), "the composer of \(sessionId) is shown")
        drain(0.2)
    }

    /// Types into the shown composer and presses Return (the keyboard's Send).
    private func typeAndReturn(_ text: String, sessionId: String) throws {
        let field = try XCTUnwrap(editor())
        field.becomeFirstResponder()
        if !text.isEmpty {
            field.insertText(text)
            XCTAssertTrue(drain(until: { self.app?.sessionStore.drafts[sessionId] == text }))
        }
        let sends = sentAttachments.count
        field.insertText("\n")
        XCTAssertTrue(drain(until: { self.sentAttachments.count == sends + 1 }), "Return sent the message")
    }

    private func stage(_ sessionId: String) throws -> StagedComposerImage {
        let png = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }.pngData())
        let image = StagedComposerImage(data: png, mimeType: "image/png")
        app?.sessionStore.setStagedImage(sessionId, image)
        return image
    }

    /// Whether the thumbnail (with its Remove control) is shown, once the
    /// composer has settled on `expected`.
    private func showsThumbnail(_ expected: Bool) -> Bool {
        drain(until: { !self.accessible("Remove image").isEmpty == expected }, timeout: 2)
        return !accessible("Remove image").isEmpty
    }

    func testStagedImageSurvivesNavigationAndSendCarriesItOnce() throws {
        let app = makeApp()
        _ = try stage(sessionA)
        try show(sessionA)
        XCTAssertTrue(showsThumbnail(true), "the staged image is shown")

        try show(sessionB)
        XCTAssertFalse(showsThumbnail(false), "another Session has no image")
        try typeAndReturn("for b", sessionId: sessionB)
        XCTAssertEqual(sentAttachments, [0], "the other Session's message carries no image")

        try show(sessionA)
        XCTAssertTrue(showsThumbnail(true), "the image is still staged after navigating away and back")
        try typeAndReturn("with picture", sessionId: sessionA)
        XCTAssertEqual(sentAttachments, [0, 1], "Send carries the image staged before navigating away")
        XCTAssertNil(app.sessionStore.stagedImages[sessionA], "Send removes the staged image")
        XCTAssertFalse(showsThumbnail(false))

        try show(sessionB)
        try show(sessionA)
        XCTAssertFalse(showsThumbnail(false))
        try typeAndReturn("follow-up", sessionId: sessionA)
        XCTAssertEqual(sentAttachments, [0, 1, 0], "the image is sent once")
    }

    func testImageOnlyDraftSurvivesNavigation() throws {
        _ = makeApp()
        _ = try stage(sessionA)
        try show(sessionA)
        try show(sessionB)
        try show(sessionA)
        try typeAndReturn("", sessionId: sessionA)
        XCTAssertEqual(sentTexts, ["[image]"])
        XCTAssertEqual(sentAttachments, [1])
    }

    func testRemoveThumbnailAndClearRemoveTheStagedImage() throws {
        let app = makeApp()
        _ = try stage(sessionA)
        try show(sessionA)
        try show(sessionB)
        try show(sessionA)
        try activate("Remove image")
        XCTAssertNil(app.sessionStore.stagedImages[sessionA], "× on the thumbnail removes the staged image")
        try show(sessionB)
        try show(sessionA)
        XCTAssertFalse(showsThumbnail(false), "a removed image stays removed after navigating")

        _ = try stage(sessionA)
        app.sessionStore.setDraft(sessionA, "draft")
        try show(sessionB)
        try show(sessionA)
        try activate("Clear message")
        XCTAssertEqual(app.sessionStore.drafts[sessionA] ?? "", "", "Clear empties the draft")
        XCTAssertNil(app.sessionStore.stagedImages[sessionA], "Clear removes the staged image")
        try typeAndReturn("text only", sessionId: sessionA)
        XCTAssertEqual(sentAttachments, [0])
    }

    func testAnswerCarriesTheImageOnlyWhenTheAgentTakesImages() throws {
        let app = makeApp()
        let question = PendingQuestion(id: "q1", sessionId: sessionA, question: "Which?", choices: nil, timestamp: Date())

        // Claude answers take text only: the image stays for a later message.
        app.sessionStore.sessions[sessionA]?.agent = "claude"
        let image = try stage(sessionA)
        try show(sessionB)
        try show(sessionA, question: question)
        try typeAndReturn("text answer", sessionId: sessionA)
        XCTAssertEqual(sentAnswerTo, ["q1"])
        XCTAssertEqual(sentAttachments, [0])
        XCTAssertEqual(app.sessionStore.stagedImages[sessionA], image, "a text-only answer keeps the image")

        // Pi takes the image with the answer, once.
        app.sessionStore.sessions[sessionA]?.agent = "pi"
        let piQuestion = PendingQuestion(id: "q2", sessionId: sessionA, question: "And?", choices: nil, timestamp: Date())
        try show(sessionB)
        try show(sessionA, question: piQuestion)
        try typeAndReturn("pi answer", sessionId: sessionA)
        XCTAssertEqual(sentAnswerTo, ["q1", "q2"])
        XCTAssertEqual(sentAttachments, [0, 1])
        XCTAssertNil(app.sessionStore.stagedImages[sessionA], "the answer took the image")
    }

    func testVoiceSendCarriesTheImageStagedBeforeNavigation() throws {
        let driver = IOSVoiceHoldScenarioDriver(automaticCorrections: false, automaticPartials: false)
        let app = makeApp(driver: driver)
        _ = try stage(sessionA)
        try show(sessionA)
        try show(sessionB)
        try show(sessionA)

        let voice = app.iosVoiceComposer
        voice.begin(sessionID: sessionA, selection: nil, context: .init(fields: [:], vocabulary: []))
        let controller = app.voiceInputController
        XCTAssertTrue(drain(until: { controller.isRecording && controller.activeSessionID == self.sessionA }),
                      "voice never started recording; controller=\(controller.state)")
        driver.emit(.partial("spoken words"))
        XCTAssertTrue(drain(until: { voice.rawText == "spoken words" }))
        try activate("Send message")
        XCTAssertNil(app.sessionStore.stagedImages[sessionA], "the voice message took the image")

        driver.emit(.final("spoken words", rawText: "spoken words"))
        XCTAssertTrue(drain(until: { !self.sentAttachments.isEmpty }), "the corrected voice message is sent")
        XCTAssertEqual(sentAttachments, [1], "the voice message carries the image once")
    }
}

/// The thumbnail is decoded once per attachment, not on every update.
@MainActor final class IOSComposerImagesTests: XCTestCase {
    func testPreviewIsDecodedOncePerAttachment() throws {
        let png = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in }.pngData())
        let first = StagedComposerImage(data: png, mimeType: "image/png")
        let preview = try XCTUnwrap(IOSComposerImages.preview(first))
        XCTAssertTrue(IOSComposerImages.preview(first) === preview, "the same attachment reuses its decoded preview")
        let second = StagedComposerImage(data: png, mimeType: "image/png")
        XCTAssertFalse(IOSComposerImages.preview(second) === preview, "a new attachment gets its own preview")
        XCTAssertNil(IOSComposerImages.preview(StagedComposerImage(data: Data([1, 2, 3]), mimeType: "image/png")))
    }
}
#endif
