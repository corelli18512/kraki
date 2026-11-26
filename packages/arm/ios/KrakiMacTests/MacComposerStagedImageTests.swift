import XCTest
import SwiftUI
import AppKit
import os
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

    private func clickClear() throws { try click("chat-clear") }

    private func click(_ identifier: String) throws {
        let marker = try XCTUnwrap(views(try XCTUnwrap(window.contentView)).first { $0.identifier?.rawValue == identifier },
                                   "missing \(identifier) control geometry")
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

    /// PR #669 review P1: an image being prepared (a large GIF being fitted)
    /// shows loading in the image slot with the ×, which cancels it; Send
    /// waits for it meanwhile.
    func testImageBeingPreparedShowsLoadingAndItsRemoveButtonCancelsIt() throws {
        show(sessionA)
        try stageImage(in: sessionA)
        app.sessionStore.setDraft(sessionA, "Text only")
        let (hold, release) = AsyncStream<Void>.makeStream()
        var stagedLate = false
        app.sessionStore.prepareStagedImage(sessionA, { for await _ in hold {} }) { _ in stagedLate = true }
        drain(300)
        XCTAssertNil(app.sessionStore.stagedImages[sessionA], "the image being prepared replaces the staged one")
        XCTAssertTrue(views(try XCTUnwrap(window.contentView)).contains { $0 is NSProgressIndicator },
                      "the image slot shows the image loading")
        try editor().onSubmit?()
        drain(100)
        XCTAssertTrue(sent.isEmpty, "Send waits for the image")

        try click("chat-remove-image")
        XCTAssertFalse(app.sessionStore.isPreparingImage(sessionA), "× cancels it")
        release.finish()
        drain(300)
        XCTAssertFalse(stagedLate, "a cancelled image is not staged when it is ready")
        XCTAssertNil(app.sessionStore.stagedImages[sessionA])
        try editor().onSubmit?()
        drain(300)
        XCTAssertEqual(sent.map(\.attachments), [0], "after × the text goes alone")
    }

    /// PR #669 review P2: the agent turning busy while an image is being
    /// prepared locks attaching, but the × still cancels the image (Send
    /// waits for it, so a locked × left only Clear, which drops the text).
    func testRemoveCancelsAnImageBeingPreparedWhileTheAgentIsBusy() throws {
        show(sessionA)
        app.sessionStore.setDraft(sessionA, "Keep me")
        let (hold, release) = AsyncStream<Void>.makeStream()
        defer { release.finish() }
        app.sessionStore.prepareStagedImage(sessionA, { for await _ in hold {} }) { _ in }
        app.sessionStore.sessions[sessionA]?.state = .active
        drain(300)
        try click("chat-remove-image")
        XCTAssertFalse(app.sessionStore.isPreparingImage(sessionA), "× cancels it while the agent is busy")
        XCTAssertEqual(app.sessionStore.drafts[sessionA], "Keep me", "the text stays")
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

    /// An image being prepared replaces the staged one at once and is
    /// staged when ready, unless a newer choice came first.
    func testImageBeingPreparedReplacesTheStagedOneAndTheLatestChoiceWins() async throws {
        let store = SessionStore(persistenceEnabled: false)
        let imageA = StagedComposerImage(data: Data([1]), mimeType: "image/png")
        let imageB = StagedComposerImage(data: Data([2]), mimeType: "image/gif")
        store.setStagedImage("a", imageA)
        store.prepareStagedImage("a", { imageB }) { store.setStagedImage("a", $0) }
        XCTAssertNil(store.stagedImages["a"], "image A goes at once")
        XCTAssertTrue(store.isPreparingImage("a"))
        try await waitBriefly { store.stagedImages["a"] != nil }
        XCTAssertEqual(store.stagedImages["a"], imageB)
        XCTAssertFalse(store.isPreparingImage("a"))

        // A newer choice (another image, or × with nil) drops the one still
        // being prepared.
        let (hold, release) = AsyncStream<Void>.makeStream()
        var stagedLate = false
        store.prepareStagedImage("a", { for await _ in hold {} }) { _ in stagedLate = true }
        store.setStagedImage("a", imageA)
        XCTAssertFalse(store.isPreparingImage("a"))
        release.finish()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(stagedLate)
        XCTAssertEqual(store.stagedImages["a"], imageA)

        // It goes with its Session.
        store.prepareStagedImage("a", { }) { _ in }
        store.removeSession("a")
        XCTAssertFalse(store.isPreparingImage("a"))
        store.prepareStagedImage("b", { }) { _ in }
        store.reset()
        XCTAssertFalse(store.isPreparingImage("b"))
    }

    /// PR #669 review P2: dropping an image still being prepared (a newer
    /// image, × or a send, the Session going, `reset`) also stops the work
    /// preparing it; it used to run on (a GIF fit redraws every frame up to
    /// four times) for a result then dropped.
    func testDroppingAnImageBeingPreparedCancelsItsWork() async throws {
        let store = SessionStore(persistenceEnabled: false)
        let cancelled = OSAllocatedUnfairLock(initialState: Set<String>())
        var stagedLate: [String] = []
        func prepare(_ id: String, _ name: String) {
            store.prepareStagedImage(id, {
                // Bounded: without cancellation it gives up after ~2 s.
                for _ in 0..<200 where !Task.isCancelled { try? await Task.sleep(for: .milliseconds(10)) }
                if Task.isCancelled { cancelled.withLock { _ = $0.insert(name) } }
            }) { _ in stagedLate.append(name) }
        }
        func waitCancelled(_ names: Set<String>) async throws {
            try await waitBriefly { cancelled.withLock { $0 } == names }
            XCTAssertEqual(cancelled.withLock { $0 }, names)
        }

        prepare("a", "replaced by a newer image")
        prepare("a", "removed by ×")
        try await waitCancelled(["replaced by a newer image"])
        store.setStagedImage("a", nil)
        try await waitCancelled(["replaced by a newer image", "removed by ×"])

        prepare("b", "its Session removed")
        store.removeSession("b")
        prepare("c", "reset")
        store.reset()
        try await waitCancelled(["replaced by a newer image", "removed by ×", "its Session removed", "reset"])
        XCTAssertEqual(stagedLate, [], "nothing cancelled is staged")

        // The latest choice still wins, and goes in once prepared.
        let image = StagedComposerImage(data: Data([1]), mimeType: "image/gif")
        store.prepareStagedImage("a", { image }) { store.setStagedImage("a", $0) }
        try await waitBriefly { store.stagedImages["a"] != nil }
        XCTAssertEqual(store.stagedImages["a"], image)
    }

    func testEachStagedImageHasItsOwnIdentity() {
        let data = Data([1, 2, 3])
        XCTAssertNotEqual(StagedComposerImage(data: data, mimeType: "image/png"),
                          StagedComposerImage(data: data, mimeType: "image/png"),
                          "the preview cache is keyed by attachment, not by bytes")
    }
}
