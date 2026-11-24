#if os(iOS)
import Photos
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// iOS chat images: Save to Photos and Share hand on the original bytes (a
/// GIF stays a GIF), a refused Photos access leads to Settings, and GIFs
/// animate in thumbnails and the viewer (paused under Reduce Motion).
@MainActor
final class IOSChatImageActionsTests: XCTestCase {
    private final class FakeLibrary: ChatPhotoLibrary {
        var status: PHAuthorizationStatus
        var afterRequest: PHAuthorizationStatus
        var requests = 0
        var added: [ChatImageFile] = []
        var failure: Error?

        init(status: PHAuthorizationStatus, afterRequest: PHAuthorizationStatus = .denied) {
            self.status = status
            self.afterRequest = afterRequest
        }

        func authorizationStatus() -> PHAuthorizationStatus { status }

        func requestAuthorization() async -> PHAuthorizationStatus {
            requests += 1
            status = afterRequest
            return status
        }

        func addImage(_ file: ChatImageFile) async throws {
            if let failure { throw failure }
            added.append(file)
        }
    }

    override func tearDown() {
        ChatGIFPlayer.reduceMotionOverride = nil
        super.tearDown()
    }

    func testSaveToPhotosAddsTheOriginalGIF() async throws {
        let gif = try ChatGIFFixture.gif(frames: 3)
        let library = FakeLibrary(status: .authorized)
        let outcome = await IOSChatImageActions.saveToPhotos(ChatGIFFixture.file(gif), library: library)
        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(library.added.map(\.data), [gif], "the GIF's own bytes, not a re-encoded still")
        XCTAssertEqual(library.added.first?.contentType, .gif)
        XCTAssertEqual(library.requests, 0)
    }

    func testFirstSaveAsksForAddOnlyAccess() async throws {
        let library = FakeLibrary(status: .notDetermined, afterRequest: .authorized)
        let outcome = await IOSChatImageActions.saveToPhotos(ChatGIFFixture.file(try ChatGIFFixture.png(), mimeType: "image/png"), library: library)
        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(library.requests, 1)
        XCTAssertEqual(library.added.count, 1)
    }

    func testRefusedOrRestrictedAccessSavesNothing() async throws {
        for (status, afterRequest) in [(PHAuthorizationStatus.denied, PHAuthorizationStatus.denied), (.restricted, .restricted), (.notDetermined, .denied)] {
            let library = FakeLibrary(status: status, afterRequest: afterRequest)
            let outcome = await IOSChatImageActions.saveToPhotos(ChatGIFFixture.file(try ChatGIFFixture.gif(frames: 2)), library: library)
            XCTAssertEqual(outcome, .denied, "\(status.rawValue)")
            XCTAssertTrue(library.added.isEmpty)
        }
        let failing = FakeLibrary(status: .authorized)
        failing.failure = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Disk full"])
        let failed = await IOSChatImageActions.saveToPhotos(ChatGIFFixture.file(try ChatGIFFixture.gif(frames: 2)), library: failing)
        XCTAssertEqual(failed, .failed("Disk full"))
    }

    func testRefusedAccessAlertOffersSettings() {
        let alert = IOSChatImageActions.deniedAlert()
        XCTAssertEqual(alert.title, "Allow Kraki to Add Photos")
        XCTAssertEqual(alert.actions.map(\.title), ["Cancel", "Open Settings"])
    }

    func testShareSheetGetsTheOriginalFileWithItsName() throws {
        let gif = try ChatGIFFixture.gif(frames: 2)
        let items = try XCTUnwrap(IOSChatImageActions.shareItems(ChatGIFFixture.file(gif, label: "party")))
        XCTAssertEqual(items.count, 1)
        let url = try XCTUnwrap(items.first)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertEqual(url.lastPathComponent, "party.gif")
        XCTAssertEqual(try Data(contentsOf: url), gif)
    }

    func testThumbnailAnimatesAGIF() async throws {
        ChatGIFPlayer.reduceMotionOverride = false
        let gif = try ChatGIFFixture.gif(frames: 3, delays: [0.04, 0.04, 0.04])
        let still = try XCTUnwrap(UIImage(data: gif))
        let view = ChatAnimatedImageView(frame: CGRect(x: 0, y: 0, width: 40, height: 20))
        view.showsPausedBadge = true
        // In a window (never shown): an off-window image does not play.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        window.addSubview(view)
        var shown = Set<Int>()
        view.show(still, file: ChatGIFFixture.file(gif))
        try await waitBriefly(seconds: 10) { view.isPlaying }
        XCTAssertTrue(view.isAnimated)
        XCTAssertTrue(view.isPlaying)
        let deadline = Date().addingTimeInterval(10)
        while shown.count < 3, Date() < deadline {
            if let channel = dominantChannel(view.image) { shown.insert(channel) }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(shown, [0, 1, 2], "red, green and blue frames all shown")
        XCTAssertEqual(view.image?.size ?? .zero, still.size, "frames keep the still image's size")
        XCTAssertFalse(view.isPausedBadgeVisible, "no badge while playing")
    }

    func testReduceMotionKeepsTheFirstFrameWithABadgeUntilPlayed() async throws {
        ChatGIFPlayer.reduceMotionOverride = true
        let gif = try ChatGIFFixture.gif(frames: 3, delays: [0.03, 0.03, 0.03])
        let view = ChatAnimatedImageView()
        view.showsPausedBadge = true
        view.player.setVisible(true)
        view.show(UIImage(data: gif), file: ChatGIFFixture.file(gif))
        try await waitBriefly(seconds: 10) { view.isAnimated }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertFalse(view.isPlaying)
        let color = ChatGIFFixture.centerColor(try XCTUnwrap(view.image?.cgImage))
        XCTAssertGreaterThan(color.0, 0.9, "first (red) frame")
        XCTAssertTrue(view.isPausedBadgeVisible, "a play badge marks the paused GIF")
        view.togglePlayback()
        XCTAssertTrue(view.isPlaying)
        XCTAssertFalse(view.isPausedBadgeVisible)
    }

    func testViewerShowsPlayPauseForAGIFOnly() async throws {
        ChatGIFPlayer.reduceMotionOverride = true
        let gif = try ChatGIFFixture.gif(frames: 2)
        let viewer = IOSZoomableImageView(frame: CGRect(x: 0, y: 0, width: 300, height: 400))
        var closed = 0
        viewer.onBackdropTap = { closed += 1 }
        viewer.imageView.player.setVisible(true)
        viewer.show(try XCTUnwrap(UIImage(data: try ChatGIFFixture.png())), file: nil)
        viewer.layoutIfNeeded()
        XCTAssertTrue(viewer.playbackButton.isHidden, "a still image has nothing to play")
        viewer.show(try XCTUnwrap(UIImage(data: gif)), file: ChatGIFFixture.file(gif))
        try await waitBriefly(seconds: 10) { !viewer.playbackButton.isHidden }
        XCTAssertFalse(viewer.playbackButton.isHidden)
        XCTAssertEqual(viewer.playbackButton.accessibilityLabel, "Play Animation", "paused under Reduce Motion")
        viewer.playbackButton.sendActions(for: .touchUpInside)
        XCTAssertTrue(viewer.imageView.isPlaying)
        XCTAssertEqual(viewer.playbackButton.accessibilityLabel, "Pause Animation")
        #if DEBUG
        viewer.layoutIfNeeded()
        XCTAssertFalse(viewer.tapForRegression(at: CGPoint(x: viewer.playbackButton.frame.midX, y: viewer.playbackButton.frame.midY)))
        XCTAssertEqual(closed, 0, "the button is not the backdrop")
        #endif
    }

    func testViewerToolbarOffersSaveAndShareForTheImageShown() throws {
        try requireForegroundUITests()
        let tree = try AccessibilityTreeHost()
        defer { tree.tearDown() }
        let gif = try ChatGIFFixture.gif(frames: 2)
        let png = try ChatGIFFixture.png()
        let saved = IOSImagePreviewItem(id: "inline-0", image: try XCTUnwrap(UIImage(data: gif)), title: "Image", file: ChatGIFFixture.file(gif))
        _ = try tree.show(IOSImagePreviewGallery(selection: IOSImagePreviewSelection(items: [saved])))
        tree.drain(0.4)
        XCTAssertEqual(tree.elements(label: "Save to Photos").count, 1, "\(tree.describeElements())")
        XCTAssertEqual(tree.elements(label: "Share…").count, 1, "\(tree.describeElements())")
        // An image without its bytes (a decoded preview only) offers neither.
        let bare = IOSImagePreviewItem(id: "inline-0", image: try XCTUnwrap(UIImage(data: png)), title: "Image")
        _ = try tree.show(IOSImagePreviewGallery(selection: IOSImagePreviewSelection(items: [bare])))
        XCTAssertTrue(tree.elements(label: "Save to Photos").isEmpty)
    }

    /// 0 red, 1 green, 2 blue: the strongest channel at the image's centre.
    private func dominantChannel(_ image: UIImage?) -> Int? {
        guard let cgImage = image?.cgImage else { return nil }
        let color = ChatGIFFixture.centerColor(cgImage)
        return [color.0, color.1, color.2].enumerated().max { $0.element < $1.element }?.offset
    }

}
#endif
