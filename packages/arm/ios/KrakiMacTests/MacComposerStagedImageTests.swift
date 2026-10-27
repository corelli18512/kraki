import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// Mac input audit finding 7: an image staged in a Session's composer must
/// survive switching to another Session and back (the Chat view, and with it
/// the composer, is rebuilt per Session), and Send / Clear must still remove it.
/// Off-screen window, in-process events only.
@MainActor
final class MacComposerStagedImageTests: XCTestCase {
    private let sessionA = "staged-image-a"
    private let sessionB = "staged-image-b"
    private var app: AppState!
    private var window: NSWindow!
    private var sent: [(session: String, text: String, attachments: Int)] = []

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-staged-image-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        for id in [sessionA, sessionB] {
            app.sessionStore.sessions[id] = SessionInfo(
                id: id, deviceId: "dev", deviceName: "Mac", agent: "pi", title: id,
                state: .idle, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1, createdAt: Date(), pinned: false)
        }
        app.testOutboundMessageHandler = { [weak self] msg, _, _ in
            if msg["type"] as? String == "send_input", let payload = msg["payload"] as? [String: Any] {
                self?.sent.append((msg["sessionId"] as? String ?? "",
                                   payload["text"] as? String ?? "",
                                   (payload["attachments"] as? [Any])?.count ?? 0))
            }
            return true
        }
        window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 700, height: 140),
                          styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.orderFront(nil)
    }

    override func tearDown() {
        window?.orderOut(nil); window?.contentView = nil
        window = nil; app = nil; sent = []
        super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }

    /// Mounts a fresh composer, as `MacChatView` does per Session.
    private func show(_ sessionId: String) {
        window.contentView = NSHostingView(rootView: MacChatComposer(sessionId: sessionId).environment(app))
        drain(400)
    }

    private func editor() throws -> MacComposerTextView {
        try XCTUnwrap(views(try XCTUnwrap(window.contentView)).compactMap { $0 as? MacComposerTextView }.first)
    }

    private func pngData() throws -> Data {
        try XCTUnwrap(NSImage(size: NSSize(width: 4, height: 4), flipped: false) { rect in
            NSColor.systemTeal.setFill(); rect.fill(); return true
        }.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) })
    }

    /// Stages an image in the mounted composer through a production path
    /// (Edit on a staged bubble moves its image into the composer).
    private func stageImage(in sessionId: String) throws {
        let sender = try XCTUnwrap(app.commandSender)
        let clientID = try XCTUnwrap(sender.stageInput(sessionId: sessionId, text: "", attachments: [
            .init(type: "image", mimeType: "image/png", data: try pngData().base64EncodedString()),
        ]))
        NotificationCenter.default.post(name: .krakiVoiceEditRequested, object: nil,
                                        userInfo: ["sessionId": sessionId, "clientId": clientID])
        drain(200)
        XCTAssertTrue(sender.pendingInputs(sessionId).isEmpty, "the image moved from the bubble into the composer")
    }

    private func clickClear() throws {
        let marker = try XCTUnwrap(views(try XCTUnwrap(window.contentView)).first { $0.identifier?.rawValue == "chat-clear" },
                                   "missing clear control geometry")
        let frame = marker.convert(marker.bounds, to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(
                with: type, location: CGPoint(x: frame.midX, y: frame.midY), modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        drain(300)
    }

    func testStagedImageSurvivesSessionSwitchAndSendRemovesIt() throws {
        show(sessionA)
        try stageImage(in: sessionA)
        app.sessionStore.setDraft(sessionA, "Look at this")
        drain(100)

        show(sessionB)
        app.sessionStore.setDraft(sessionB, "Other chat")
        drain(100)
        try editor().onSubmit?()
        drain(300)
        XCTAssertEqual(sent.map(\.attachments), [0], "the image stays with its own Session")

        show(sessionA)
        try editor().onSubmit?()
        drain(300)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent.last?.session, sessionA)
        XCTAssertEqual(sent.last?.text, "Look at this")
        XCTAssertEqual(sent.last?.attachments, 1, "the staged image survived the Session switch")

        // Sent: the image does not come back on the next visit.
        show(sessionB)
        show(sessionA)
        app.sessionStore.setDraft(sessionA, "Follow-up")
        drain(100)
        try editor().onSubmit?()
        drain(300)
        XCTAssertEqual(sent.count, 3)
        XCTAssertEqual(sent.last?.attachments, 0, "a sent image is not staged again")
    }

    func testClearRemovesImageStagedBeforeSessionSwitch() throws {
        show(sessionA)
        try stageImage(in: sessionA)
        app.sessionStore.setDraft(sessionA, "Clear me")
        show(sessionB)
        show(sessionA)
        try clickClear()
        XCTAssertNil(app.sessionStore.drafts[sessionA], "the Clear click reached the button")

        show(sessionB)
        show(sessionA)
        app.sessionStore.setDraft(sessionA, "Text only")
        drain(100)
        try editor().onSubmit?()
        drain(300)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.last?.text, "Text only")
        XCTAssertEqual(sent.last?.attachments, 0, "Clear removed the staged image for good")
    }

    /// An image-only draft (no text) is still sendable after the switch.
    func testImageOnlyDraftSurvivesSessionSwitch() throws {
        show(sessionA)
        try stageImage(in: sessionA)
        show(sessionB)
        show(sessionA)
        try editor().onSubmit?()
        drain(300)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.last?.text, "[image]")
        XCTAssertEqual(sent.last?.attachments, 1)
    }
}

/// The store side of finding 7: a staged image lives and dies with its Session.
@MainActor
final class SessionStoreStagedImageTests: XCTestCase {
    func testStagedImageIsPerSessionAndGoesWithTheSession() {
        let store = SessionStore(persistenceEnabled: false)
        let image = StagedComposerImage(data: Data([1, 2, 3]), mimeType: "image/png")
        store.setStagedImage("a", image)
        XCTAssertEqual(store.stagedImages["a"], image)
        XCTAssertNil(store.stagedImages["b"])
        store.setStagedImage("a", nil)
        XCTAssertNil(store.stagedImages["a"])

        store.setStagedImage("a", image)
        store.removeSession("a")
        XCTAssertNil(store.stagedImages["a"], "a deleted Session leaves no staged image")

        store.setStagedImage("b", image)
        store.reset()
        XCTAssertTrue(store.stagedImages.isEmpty, "sign-out/reset drops staged images")
    }

    func testSessionListWithoutTheSessionDropsItsStagedImage() {
        let store = SessionStore(persistenceEnabled: false)
        func digest(_ id: String) -> SessionDigest {
            SessionDigest(id: id, agent: "pi", state: .idle, mode: .auto, lastSeq: 1, readSeq: 1,
                          messageCount: 1, createdAt: "2026-01-01T00:00:00Z")
        }
        store.reconcileSessionList([digest("a"), digest("b")], deviceId: "dev", deviceName: "Mac")
        let image = StagedComposerImage(data: Data([1, 2, 3]), mimeType: "image/png")
        store.setStagedImage("a", image)
        store.setStagedImage("b", image)
        store.setDraft("a", "draft")
        let removed = store.reconcileSessionList([digest("b")], deviceId: "dev", deviceName: "Mac")
        XCTAssertEqual(removed, ["a"])
        XCTAssertNil(store.drafts["a"])
        XCTAssertNil(store.stagedImages["a"], "removed with its draft")
        XCTAssertEqual(store.stagedImages["b"], image, "a Session still listed keeps its image")
    }

    func testEachStagedImageHasItsOwnIdentity() {
        let data = Data([1, 2, 3])
        XCTAssertNotEqual(StagedComposerImage(data: data, mimeType: "image/png"),
                          StagedComposerImage(data: data, mimeType: "image/png"),
                          "the preview cache is keyed by attachment, not by bytes")
    }
}
