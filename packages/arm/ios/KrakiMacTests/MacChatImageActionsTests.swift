import AppKit
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
