#if os(macOS)
import AppKit
import XCTest
@testable import Kraki_Dev

/// The composer's edge fade hints at hidden text only. Observed on macOS 26
/// with real typing: after a shrink animation a one-line draft's text view
/// settled at 22 pt in a 20 pt clip, and the old 0.5 pt threshold faded the
/// bottom of the only line ("the text below looks blurred").
@MainActor
final class MacScrollEdgeFadeTests: XCTestCase {
    private func makeScroll(clip: CGFloat, document: CGFloat, scrolledTo y: CGFloat = 0) -> (NSScrollView, MacScrollEdgeFade) {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: clip))
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        let doc = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: document))
        scroll.documentView = doc
        let fade = MacScrollEdgeFade(scroll)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
        fade.update()
        return (scroll, fade)
    }

    func testPaddingOverflowOfOneLineDraftDoesNotFade() {
        let (scroll, fade) = makeScroll(clip: 20, document: 22)
        XCTAssertFalse(fade.fadesBottom)
        XCTAssertFalse(fade.fadesTop)
        XCTAssertNil(scroll.layer?.mask)
        let (scrolled, scrolledFade) = makeScroll(clip: 20, document: 22, scrolledTo: 2)
        XCTAssertFalse(scrolledFade.fadesTop)
        XCTAssertFalse(scrolledFade.fadesBottom)
        XCTAssertNil(scrolled.layer?.mask)
    }

    func testHiddenLinesStillFade() {
        // Four lines in a three-line composer: one line hidden below.
        let (atTop, topFade) = makeScroll(clip: 56, document: 74)
        XCTAssertTrue(topFade.fadesBottom)
        XCTAssertFalse(topFade.fadesTop)
        XCTAssertNotNil(atTop.layer?.mask)
        let (atBottom, bottomFade) = makeScroll(clip: 56, document: 74, scrolledTo: 18)
        XCTAssertTrue(bottomFade.fadesTop)
        XCTAssertFalse(bottomFade.fadesBottom)
        XCTAssertNotNil(atBottom.layer?.mask)
        let (middle, middleFade) = makeScroll(clip: 56, document: 110, scrolledTo: 27)
        XCTAssertTrue(middleFade.fadesTop && middleFade.fadesBottom)
        XCTAssertNotNil(middle.layer?.mask)
    }
}
#endif
