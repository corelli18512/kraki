import AppKit
import SwiftUI
import UniformTypeIdentifiers
import XCTest
@testable import Kraki_Dev

/// Mac chat images: Save Image… names the file after the image with its
/// real extension and writes the original bytes, Copy Image keeps a GIF a
/// GIF, both are on the right-click menu, GIFs animate (paused under Reduce
/// Motion), and the composer sends a GIF within the limits as it is.
/// Private pasteboards only: the general pasteboard is never touched.
@MainActor
final class MacChatImageActionsTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("mac-chat-image-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        ChatGIFPlayer.reduceMotionOverride = nil
        MacGIFScreenPresence.windowShownOverride = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        super.tearDown()
    }

    func testSavePanelSuggestsTheImagesNameAndRealType() throws {
        let gif = ChatGIFFixture.file(try ChatGIFFixture.gif(frames: 2))
        let panel = MacChatImageActions.savePanel(for: gif)
        XCTAssertEqual(panel.nameFieldStringValue, "kraki-image.gif")
        XCTAssertEqual(panel.allowedContentTypes, [.gif])
        XCTAssertFalse(panel.isExtensionHidden)

        let ref = ContentRef(type: "content_ref", id: "r", mimeType: "image/jpeg", size: 3, caption: "Chart", name: "chart.png", width: nil, height: nil)
        let jpeg = MacChatImageActions.savePanel(for: ChatImageFile(ref: ref, mimeType: "image/jpeg", data: Data([0xFF, 0xD8, 0xFF])))
        XCTAssertEqual(jpeg.nameFieldStringValue, "chart.jpg")
        XCTAssertEqual(jpeg.allowedContentTypes, [.jpeg])
    }

    func testSaveWritesTheOriginalBytes() throws {
        let data = try ChatGIFFixture.gif(frames: 3)
        let url = directory.appendingPathComponent("saved.gif")
        try MacChatImageActions.write(ChatGIFFixture.file(data), to: url)
        XCTAssertEqual(try Data(contentsOf: url), data)
    }

    func testCopyImageKeepsTheGIFAndAddsAPicture() throws {
        let data = try ChatGIFFixture.gif(frames: 3)
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        MacChatImageActions.copy(ChatGIFFixture.file(data), to: pasteboard)
        XCTAssertEqual(pasteboard.data(forType: NSPasteboard.PasteboardType(UTType.gif.identifier)), data)
        XCTAssertNotNil(pasteboard.data(forType: .tiff), "apps that only take pictures still paste")
    }

    func testRightClickMenuOffersSaveAndCopy() throws {
        let menu = MacChatImageActions.menu(for: ChatGIFFixture.file(try ChatGIFFixture.gif(frames: 2)))
        XCTAssertEqual(menu.items.map(\.title), ["Save Image…", "Copy Image"])
        XCTAssertTrue(menu.items.allSatisfy { $0.target != nil && $0.action != nil })
    }

    func testThumbnailAnimatesAndHasTheImageMenu() async throws {
        ChatGIFPlayer.reduceMotionOverride = false
        let data = try ChatGIFFixture.gif(frames: 3, delays: [0.04, 0.04, 0.04])
        let button = MacPreviewImageNativeButton(frame: NSRect(x: 0, y: 0, width: 80, height: 40))
        button.previewImage = NSImage(data: data)
        button.player.setVisible(true)
        XCTAssertNil(button.menu(for: try rightClick()), "no bytes yet: no image menu")
        var frames = 0
        button.player.show(ChatGIFFixture.file(data))
        let shown = button.player.onFrame
        button.player.onFrame = { frames += 1; shown($0) }
        try await waitBriefly(seconds: 10) { frames >= 3 }
        XCTAssertTrue(button.player.isPlaying)
        XCTAssertGreaterThanOrEqual(frames, 3)
        XCTAssertEqual(button.menu(for: try rightClick())?.items.map(\.title), ["Save Image…", "Copy Image"])
        button.player.pause()
    }

    /// The chat list parks a recycled cell hidden in its reuse pool, still in
    /// the window (`MacChatDocumentView.recycle`): its GIF must stop ticking,
    /// and play on when the cell is shown again.
    func testGIFInAHiddenPooledCellStopsTickingAndResumesWhenShown() async throws {
        try requireForegroundUITests()
        ChatGIFPlayer.reduceMotionOverride = false
        let data = try ChatGIFFixture.gif(frames: 3, delays: [0.03, 0.03, 0.03])
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 300, height: 200),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.orderOut(nil); window.contentView = nil }
        let list = NSView(frame: window.contentLayoutRect)
        window.contentView = list
        let cell = NSView(frame: list.bounds)
        list.addSubview(cell)
        let host = NSHostingView(rootView: MacBubbleImageGrid(
            inlineImages: [try XCTUnwrap(NSImage(data: data))], inlineImageFiles: [ChatGIFFixture.file(data)],
            refs: [], sessionId: "s", maxWidth: 200, alignment: .leading, attachmentStore: nil))
        host.frame = cell.bounds
        cell.addSubview(host)
        MacGIFScreenPresence.windowShownOverride = true
        var found: MacPreviewImageNativeButton?
        try await waitBriefly(seconds: 5) {
            host.layoutSubtreeIfNeeded()
            found = Self.descendant(MacPreviewImageNativeButton.self, of: host)
            return found != nil
        }
        let button = try XCTUnwrap(found)
        var frames = 0
        let shown = button.player.onFrame
        button.player.onFrame = { frames += 1; shown($0) }
        try await waitBriefly(seconds: 10) { frames >= 3 }
        XCTAssertTrue(button.player.isPlaying)

        cell.isHidden = true // what recycle() does
        let parked = frames
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(frames, parked, "a GIF in a hidden pooled cell kept ticking")

        cell.isHidden = false // dequeued and shown again
        try await waitBriefly(seconds: 10) { frames >= parked + 3 }
        XCTAssertGreaterThanOrEqual(frames, parked + 3, "the GIF plays again once shown")

        // The window minimised or covered: AppKit reports the occlusion change.
        MacGIFScreenPresence.windowShownOverride = false
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        let covered = frames
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(frames, covered, "a GIF in a covered or minimised window kept ticking")
        MacGIFScreenPresence.windowShownOverride = true
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        try await waitBriefly(seconds: 10) { frames >= covered + 3 }
        XCTAssertGreaterThanOrEqual(frames, covered + 3)
        button.player.pause()
    }

    private static func descendant<View: NSView>(_ type: View.Type, of view: NSView) -> View? {
        if let match = view as? View { return match }
        for subview in view.subviews { if let match = descendant(type, of: subview) { return match } }
        return nil
    }

    func testViewerPlayPauseFollowsReduceMotion() async throws {
        ChatGIFPlayer.reduceMotionOverride = true
        let data = try ChatGIFFixture.gif(frames: 2)
        let viewer = MacZoomableImageView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        viewer.image = NSImage(data: data)
        viewer.player.setVisible(true)
        viewer.layoutSubtreeIfNeeded()
        XCTAssertTrue(viewer.playbackButton.isHidden, "a still image has nothing to play")
        viewer.player.show(ChatGIFFixture.file(data))
        try await waitBriefly(seconds: 10) { !viewer.playbackButton.isHidden }
        XCTAssertFalse(viewer.player.isPlaying, "Reduce Motion: paused on the first frame")
        XCTAssertEqual(viewer.playbackButton.accessibilityLabel(), "Play Animation")
        viewer.playbackButton.performClick(nil)
        XCTAssertTrue(viewer.player.isPlaying)
        XCTAssertEqual(viewer.playbackButton.accessibilityLabel(), "Pause Animation")
        XCTAssertEqual(viewer.menu(for: try rightClick())?.items.map(\.title), ["Save Image…", "Copy Image"])
        viewer.player.pause()
    }

    func testComposerSendsAGIFWithinTheLimitsAsItIs() throws {
        let gif = try ChatGIFFixture.gif(frames: 3, width: 300, height: 200)
        let url = directory.appendingPathComponent("party.gif")
        try gif.write(to: url)
        let staged = try XCTUnwrap(MacComposerImages.staged(try XCTUnwrap(MacComposerImages.image(contentsOf: url))))
        XCTAssertEqual(staged.mimeType, "image/gif")
        XCTAssertEqual(staged.data, gif)

        let pasted = try XCTUnwrap(MacComposerImages.staged(try XCTUnwrap(MacComposerImages.image(data: gif))))
        XCTAssertEqual(pasted.data, gif)

        let wide = try ChatGIFFixture.gif(frames: 2, width: 1600, height: 100)
        let shrunk = try XCTUnwrap(MacComposerImages.staged(try XCTUnwrap(MacComposerImages.image(data: wide))))
        XCTAssertEqual(shrunk.mimeType, "image/jpeg", "over 1024 px: a still JPEG like any picture")

        let png = try XCTUnwrap(MacComposerImages.staged(try XCTUnwrap(NSImage(data: try ChatGIFFixture.png()))))
        XCTAssertEqual(png.mimeType, "image/jpeg")
    }

    /// The GIF bytes are kept on the image only when it is sent as is, and
    /// go away with it (no table holding every pasted GIF).
    func testComposerKeepsGIFBytesOnlyWithinTheLimitsAndOnlyWhileTheImageLives() throws {
        let wide = try ChatGIFFixture.gif(frames: 2, width: 1600, height: 100)
        let over = try XCTUnwrap(MacComposerImages.image(data: wide))
        XCTAssertNil(MacComposerImages.gifSource(of: over), "an over-limit GIF is sent as a JPEG: its bytes are not kept")

        // Native Swift bytes: the image's copy is the only NSData of them.
        let gif = Data([UInt8](try ChatGIFFixture.gif(frames: 2)))
        weak var kept: NSData?
        try autoreleasepool {
            let image = try XCTUnwrap(MacComposerImages.image(data: gif))
            kept = MacComposerImages.gifSource(of: image)
            XCTAssertEqual(kept as Data?, gif)
        }
        XCTAssertNil(kept, "the GIF bytes outlived the image")
    }

    func testPastedGIFDataIsPreferredSoItStaysAnimated() throws {
        let gif = try ChatGIFFixture.gif(frames: 2)
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setData(gif, forType: NSPasteboard.PasteboardType(UTType.gif.identifier))
        item.setData(try XCTUnwrap(NSImage(data: gif)?.tiffRepresentation), forType: .tiff)
        pasteboard.writeObjects([item])
        let image = try XCTUnwrap(MacComposerPastePolicy.image(from: pasteboard))
        XCTAssertEqual(MacComposerImages.staged(image)?.data, gif)
    }

    private func rightClick() throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(
            with: .rightMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    }
}
