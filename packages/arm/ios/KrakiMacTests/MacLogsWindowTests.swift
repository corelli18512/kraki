import AppKit
import XCTest
@testable import Kraki_Dev

/// Logs window: Follow keeps the view on the newest lines (K-252). It used a
/// SwiftUI TextEditor that kept its scroll position when the text changed.
@MainActor
final class MacLogsWindowTests: XCTestCase {
    private func makeScrollView() -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        scrollView.frame = NSRect(x: 0, y: 0, width: 320, height: 120)
        scrollView.layoutSubtreeIfNeeded()
        return scrollView
    }

    private func log(_ lines: Int) -> String {
        (1...lines).map { "line \($0)" }.joined(separator: "\n")
    }

    private func isAtTail(_ scrollView: NSScrollView) -> Bool {
        let visible = scrollView.contentView.bounds
        let document = scrollView.documentView?.frame ?? .zero
        return document.height > visible.height && abs(visible.maxY - document.maxY) < 2
    }

    func testFollowShowsTheNewestLines() {
        let scrollView = makeScrollView()
        LogTextView.apply(text: log(300), follow: true, wasFollowing: false, to: scrollView)
        XCTAssertTrue(isAtTail(scrollView))

        // The log grows: still on the tail.
        LogTextView.apply(text: log(400), follow: true, wasFollowing: true, to: scrollView)
        XCTAssertTrue(isAtTail(scrollView))
    }

    func testAnUnchangedReloadKeepsWhereTheUserScrolled() {
        let scrollView = makeScrollView()
        LogTextView.apply(text: log(300), follow: true, wasFollowing: false, to: scrollView)
        scrollView.contentView.scroll(to: .zero)
        LogTextView.apply(text: log(300), follow: true, wasFollowing: true, to: scrollView)
        XCTAssertEqual(scrollView.contentView.bounds.minY, 0)
    }

    func testWithoutFollowNewLinesDoNotMoveTheView() {
        let scrollView = makeScrollView()
        LogTextView.apply(text: log(300), follow: false, wasFollowing: false, to: scrollView)
        scrollView.contentView.scroll(to: .zero)
        LogTextView.apply(text: log(400), follow: false, wasFollowing: false, to: scrollView)
        XCTAssertEqual(scrollView.contentView.bounds.minY, 0)
        // Turning Follow on jumps to the tail.
        LogTextView.apply(text: log(400), follow: true, wasFollowing: false, to: scrollView)
        XCTAssertTrue(isAtTail(scrollView))
    }
}
