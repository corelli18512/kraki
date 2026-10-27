import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// 2-18 (client side, review group 2b): the production Mac composer, with an
/// attached image and an open question, answers through Return. Pi gets the
/// image (also an image-only answer); Claude/Copilot/Codex get text only and
/// the image stays in the composer.
@MainActor
final class MacComposerAnswerImageTests: XCTestCase {
    private let sid = "answer-image"
    private var window: NSWindow?
    private var sent: [[String: Any]] = []

    override func tearDown() {
        window?.orderOut(nil); window?.contentView = nil; window = nil
        sent = []
        super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }

    /// Mounts the composer and presses Return in its editor.
    private func answer(agent: String, draft: String) throws -> MacComposerTextView {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-answer-image-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev", deviceName: "Mac", agent: agent, title: "Answer",
            state: .active, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1, createdAt: Date(), pinned: false)
        app.testOutboundMessageHandler = { [weak self] msg, _, _ in
            if let payload = msg["payload"] as? [String: Any], msg["type"] as? String == "send_input" {
                self?.sent.append(payload)
            }
            return true
        }
        app.sessionStore.setDraft(sid, draft)
        let png = try XCTUnwrap(NSImage(size: NSSize(width: 4, height: 4), flipped: false) { rect in
            NSColor.systemTeal.setFill(); rect.fill(); return true
        }.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) })
        app.sessionStore.setStagedImage(sid, StagedComposerImage(data: png, mimeType: "image/png"))
        let question = PendingQuestion(id: "q1", sessionId: sid, question: "Which screen?", choices: nil, timestamp: Date())
        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 700, height: 140),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MacChatComposer(
            sessionId: sid, pendingQuestion: question).environment(app))
        window.makeKeyAndOrderFront(nil)
        self.window = window
        drain(400)
        let content = try XCTUnwrap(window.contentView)
        let editor = try XCTUnwrap(views(content).compactMap { $0 as? MacComposerTextView }.first)
        editor.onSubmit?()
        drain(300)
        return editor
    }

    func testPiAnswerCarriesTheImage() throws {
        _ = try answer(agent: "pi", draft: "This one")
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?["answerTo"] as? String, "q1")
        XCTAssertEqual(sent.first?["text"] as? String, "This one")
        XCTAssertEqual((sent.first?["attachments"] as? [Any])?.count, 1)
    }

    func testPiImageOnlyAnswerIsSent() throws {
        _ = try answer(agent: "pi", draft: "")
        XCTAssertEqual(sent.count, 1, "an image-only answer is allowed for Pi")
        XCTAssertEqual(sent.first?["answerTo"] as? String, "q1")
        XCTAssertEqual(sent.first?["text"] as? String, "[image]")
        XCTAssertEqual((sent.first?["attachments"] as? [Any])?.count, 1)
    }

    func testTextOnlyAgentsAnswerWithoutTheImage() throws {
        for agent in ["claude", "copilot", "codex"] {
            sent = []
            _ = try answer(agent: agent, draft: "Yes")
            XCTAssertEqual(sent.count, 1, agent)
            XCTAssertEqual(sent.first?["text"] as? String, "Yes", agent)
            XCTAssertNil(sent.first?["attachments"], agent)
            tearDownWindow()

            sent = []
            _ = try answer(agent: agent, draft: "")
            XCTAssertTrue(sent.isEmpty, "\(agent): an image alone is no answer to a text-only question")
            tearDownWindow()
        }
    }

    private func tearDownWindow() {
        window?.orderOut(nil); window?.contentView = nil; window = nil
    }
}
