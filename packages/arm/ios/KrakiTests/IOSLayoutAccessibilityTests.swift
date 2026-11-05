#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// Frames that VoiceOver and touch use for small iOS controls: K-145 (header
/// mode picker width), K-156 (remove-image target), K-158 (stacked gallery
/// card frames).
@MainActor
final class IOSLayoutAccessibilityTests: XCTestCase {
    private var tree: AccessibilityTreeHost?
    private var app: AppState?

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    override func tearDown() {
        app?.iosVoiceComposer.retireKeepingDraft(); app?.voiceInputController.forgetLease()
        tree?.tearDown()
        tree = nil
        app = nil
        super.tearDown()
    }

    private func image(_ size: CGSize) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(origin: .zero, size: size))
        }
    }

    private func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }

    // MARK: K-145

    /// With long localized mode names the expanded picker used its natural
    /// (sum of labels) width and pushed past the header's trailing edge.
    func testSegmentedControlStaysInsideItsRowWithLongTitles() throws {
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let long = ["Sicherer Modus mit Rückfrage", "Automatischer Modus ohne Rückfrage", "Delegieren an den Agenten"]
        let host = try tree.show(
            HStack(spacing: 8) {
                Color.gray.frame(width: 44, height: 44)
                TintedSegmentedControl(items: long, selection: .constant(1), tintColor: .systemTeal,
                                       transparentTrack: true)
                    .frame(maxWidth: .infinity)
                    .frame(height: 34)
            }
            .padding(.horizontal, 16)
            .frame(width: 393, height: 60)
        )
        let control = try XCTUnwrap(all(host.view).compactMap { $0 as? UISegmentedControl }.first)
        let frame = control.convert(control.bounds, to: nil)
        XCTAssertGreaterThanOrEqual(frame.minX, 16 + 44 + 8 - 0.5, "\(frame)")
        XCTAssertLessThanOrEqual(frame.maxX, 393 - 16 + 0.5, "\(frame)")

        // Short titles still fill the row (the normal expanded look).
        let short = try tree.show(
            TintedSegmentedControl(items: ["Safe", "Auto", "Delegate"], selection: .constant(1), tintColor: .systemTeal)
                .frame(maxWidth: .infinity)
                .frame(width: 300, height: 34)
        )
        let shortControl = try XCTUnwrap(all(short.view).compactMap { $0 as? UISegmentedControl }.first)
        XCTAssertEqual(shortControl.bounds.width, 300, accuracy: 0.5)
    }

    // MARK: K-156

    func testRemoveImageTargetIsLargerThanTheGlyph() throws {
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        self.app = app
        let sessionId = "voice-a"
        let png = try XCTUnwrap(image(CGSize(width: 8, height: 8)).pngData())
        app.sessionStore.setStagedImage(sessionId, StagedComposerImage(data: png, mimeType: "image/png"))
        app.sessionStore.activeSessionId = sessionId
        _ = try tree.show(MessageInputView(sessionId: sessionId, pendingQuestion: nil).environment(app))
        tree.drain(0.3)

        let remove = try XCTUnwrap(tree.elements(label: "Remove image").first, "Remove image control")
        let target = remove.accessibilityFrame
        XCTAssertGreaterThanOrEqual(target.width, 32, "\(target)")
        XCTAssertGreaterThanOrEqual(target.height, 32, "\(target)")
        let replace = try XCTUnwrap(tree.elements(label: "Replace image").first).accessibilityFrame
        XCTAssertLessThanOrEqual(target.minX - replace.minX, 22, "the glyph did not move: \(target) vs \(replace)")
    }

    // MARK: K-158

    /// `scaledToFill` before the card's clip gave each stacked card the
    /// image's overflow size, so its tap / VoiceOver frame covered neighbours.
    func testStackedGalleryCardFramesStayInsideTheirCard() throws {
        let tree = try AccessibilityTreeHost()
        self.tree = tree
        let maxWidth: CGFloat = 280
        _ = try tree.show(
            BubbleImageGallery(images: [image(CGSize(width: 100, height: 400)), image(CGSize(width: 400, height: 100)),
                                        image(CGSize(width: 300, height: 300))],
                               refs: [], sessionId: "gallery", maxWidth: maxWidth, alignment: .leading,
                               attachmentStore: nil, onOpenImage: { _ in })
                .frame(width: 393, height: 400, alignment: .topLeading)
        )
        let cardWidth = IOSImageGalleryLayout.stackedCardWidth(maxWidth: maxWidth, visibleCount: 3)
        let cards = tree.elements(label: "Open image gallery")
        XCTAssertEqual(cards.count, 3)
        for card in cards {
            let frame = card.accessibilityFrame
            XCTAssertLessThanOrEqual(frame.width, cardWidth + 0.5, "\(frame)")
            XCTAssertLessThanOrEqual(frame.height, IOSImageGalleryLayout.multiCardHeight + 0.5, "\(frame)")
        }
    }
}
#endif
