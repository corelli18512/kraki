import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// 2-18 (client side, review group 2b): an answer typed in the composer
/// carries the attached image only for Pi sessions, and an image-only answer
/// is allowed there. Both composers (iPhone `MessageInputView`, Mac
/// `MacChatComposer`) answer through `ComposerAnswerImages`.
@MainActor
final class ComposerAnswerImagesTests: XCTestCase {
    private let image = [ImageAttachment(type: "image", mimeType: "image/jpeg", data: "AAAA")]

    func testOnlyPiTakesImagesInAnswers() {
        XCTAssertTrue(ComposerAnswerImages.allowed(agent: "pi"))
        for agent in ["claude", "copilot", "codex", nil] {
            XCTAssertFalse(ComposerAnswerImages.allowed(agent: agent), agent ?? "nil")
            XCTAssertNil(ComposerAnswerImages.attachments(image, agent: agent))
            XCTAssertFalse(ComposerAnswerImages.canSubmit(hasText: false, hasImage: true, agent: agent))
            XCTAssertTrue(ComposerAnswerImages.canSubmit(hasText: true, hasImage: true, agent: agent))
        }
        XCTAssertTrue(ComposerAnswerImages.canSubmit(hasText: false, hasImage: true, agent: "pi"))
        XCTAssertFalse(ComposerAnswerImages.canSubmit(hasText: false, hasImage: false, agent: "pi"))
    }

    func testAttachControlWhileAnswering() {
        // Answering: Pi only, even while the agent runs (it waits for the answer).
        XCTAssertTrue(ComposerAnswerImages.canAttach(isIdle: false, answeringQuestion: true, agent: "pi"))
        XCTAssertFalse(ComposerAnswerImages.canAttach(isIdle: true, answeringQuestion: true, agent: "claude"))
        XCTAssertFalse(ComposerAnswerImages.canAttach(isIdle: false, answeringQuestion: true, agent: "codex"))
        // Not answering: unchanged (idle only).
        XCTAssertTrue(ComposerAnswerImages.canAttach(isIdle: true, answeringQuestion: false, agent: "claude"))
        XCTAssertFalse(ComposerAnswerImages.canAttach(isIdle: false, answeringQuestion: false, agent: "pi"))
    }

    private func sender() throws -> (AppState, () -> [String: Any]?) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("answer-images-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        var last: [String: Any]?
        app.testOutboundMessageHandler = { msg, _, _ in last = msg["payload"] as? [String: Any]; return true }
        return (app, { last })
    }

    func testPiAnswerCarriesTheImageAndImageOnlyAnswerIsSent() throws {
        let (app, last) = try sender()
        XCTAssertTrue(ComposerAnswerImages.send(app.commandSender, sessionId: "s", questionId: "q1",
                                                text: "  this one ", staged: image, agent: "pi"))
        XCTAssertEqual(last()?["answerTo"] as? String, "q1")
        XCTAssertEqual(last()?["text"] as? String, "this one")
        XCTAssertEqual((last()?["attachments"] as? [[String: String]])?.first?["data"], "AAAA")

        XCTAssertTrue(ComposerAnswerImages.send(app.commandSender, sessionId: "s", questionId: "q2",
                                                text: "", staged: image, agent: "pi"))
        XCTAssertEqual(last()?["answerTo"] as? String, "q2")
        XCTAssertEqual(last()?["text"] as? String, "[image]", "Tentacle answers with empty text plus the image")
        XCTAssertEqual((last()?["attachments"] as? [[String: String]])?.count, 1)
    }

    func testTextOnlyAgentsAnswerWithoutTheImage() throws {
        let (app, last) = try sender()
        XCTAssertTrue(ComposerAnswerImages.send(app.commandSender, sessionId: "s", questionId: "q1",
                                                text: "yes", staged: image, agent: "claude"))
        XCTAssertEqual(last()?["text"] as? String, "yes")
        XCTAssertNil(last()?["attachments"])

        XCTAssertFalse(ComposerAnswerImages.send(app.commandSender, sessionId: "s", questionId: "q2",
                                                 text: " ", staged: image, agent: "codex"),
                       "an image-only answer is nothing to send for a text-only question")
        XCTAssertNotEqual(last()?["answerTo"] as? String, "q2")
    }
}
