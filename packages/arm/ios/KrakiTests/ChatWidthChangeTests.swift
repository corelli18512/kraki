#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// iPhone Duo folds and unfolds while a chat is open: the window changes width
/// under the list (466 ⇄ 951 pt). Reading position must stay on the same
/// message and every bubble must be laid out for the new width. The same
/// applies to iPad resizing and rotation.
@MainActor
final class ChatWidthChangeTests: XCTestCase {
    private var fixtures = ChatUXRegressionTests()

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    override func tearDown() async throws {
        try await fixtures.tearDown()
        try await super.tearDown()
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private func drag(_ fx: ChatUXRegressionTests.Fx, to offset: CGFloat) {
        fx.vc.scrollViewWillBeginDragging(fx.cv)
        fx.vc.automationUserScrollActive = true
        fx.cv.contentOffset.y = offset
        fx.vc.scrollViewDidScroll(fx.cv)
        fx.vc.automationUserScrollActive = false
        fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
        drain(300)
    }

    private func resize(_ fx: ChatUXRegressionTests.Fx, _ size: CGSize) {
        guard let window = fx.vc.view.window else { return XCTFail("chat is not in a window") }
        window.frame = CGRect(origin: .zero, size: size)
        fx.vc.view.frame = window.bounds
        fx.vc.view.layoutIfNeeded()
        drain(700)
        fx.cv.layoutIfNeeded()
    }

    /// The message whose top is closest to the viewport top, and that distance.
    private func anchor(_ fx: ChatUXRegressionTests.Fx) -> (id: String, delta: CGFloat)? {
        let top = fx.cv.contentOffset.y + fx.cv.adjustedContentInset.top
        let rows = fx.cv.indexPathsForVisibleItems.compactMap { ip -> (String, CGFloat)? in
            guard ip.item < fx.vc.items.count, let frame = fx.cv.layoutAttributesForItem(at: ip)?.frame,
                  frame.maxY > top else { return nil }
            return (fx.vc.items[ip.item], frame.minY - top)
        }
        return rows.min { abs($0.1) < abs($1.1) }.map { (id: $0.0, delta: $0.1) }
    }

    /// Where a given message's top is relative to the viewport top (nil if not visible).
    private func position(of id: String, _ fx: ChatUXRegressionTests.Fx) -> CGFloat? {
        guard let index = fx.vc.items.firstIndex(of: id),
              fx.cv.indexPathsForVisibleItems.contains(IndexPath(item: index, section: 0)),
              let frame = fx.cv.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return nil }
        return frame.minY - (fx.cv.contentOffset.y + fx.cv.adjustedContentInset.top)
    }

    /// Every visible bubble lies inside the list's width (nothing cut off).
    private func overflow(_ fx: ChatUXRegressionTests.Fx) -> CGFloat {
        var worst: CGFloat = 0
        func walk(_ v: UIView) {
            // TextKit's private drawing fragments are routinely wider than
            // their text view (even in a fresh layout); measure real views.
            if String(describing: type(of: v)).hasPrefix("_UITextLayout") { return }
            if !v.isHidden, v.alpha > 0, v.bounds.width > 0 {
                let r = v.convert(v.bounds, to: fx.cv)
                worst = max(worst, r.maxX - fx.cv.bounds.width)
            }
            v.subviews.forEach(walk)
        }
        fx.cv.visibleCells.forEach(walk)
        return worst
    }

    func testFoldAndUnfoldKeepTheReadingPositionAndReflowBubbles() throws {
        let fx = try fixtures.makeFixture(total: 80, onScreen: true)
        let outer = CGSize(width: 466, height: 678), inner = CGSize(width: 951, height: 669)
        resize(fx, outer)
        drag(fx, to: fx.cv.contentSize.height * 0.4)
        XCTAssertFalse(fx.vc.followingBottom, "the user scrolled away from the newest message")
        let start = try XCTUnwrap(anchor(fx))

        for (step, size) in [inner, outer, inner, outer].enumerated() {
            resize(fx, size)
            let now = try XCTUnwrap(position(of: start.id, fx), "step \(step): the message being read is still on screen")
            XCTAssertEqual(now, start.delta, accuracy: 2, "step \(step): at the same place in the viewport")
            XCTAssertFalse(fx.vc.followingBottom, "step \(step): did not jump to the newest message")
            XCTAssertLessThanOrEqual(overflow(fx), 0.5, "step \(step): bubbles laid out for \(Int(size.width)) pt")
            for cell in fx.cv.visibleCells {
                XCTAssertEqual(cell.bounds.width, fx.cv.bounds.width, accuracy: 0.5, "step \(step): row width follows the list")
            }
        }
    }

    /// The app's real chat screen (SwiftUI SessionDetailView hosting the
    /// list) in a window that is resized like a fold/unfold.
    func testRealChatScreenReflowsOnFoldAndUnfold() throws {
        let fx = try fixtures.makeFixture(total: 80, onScreen: true)
        fx.vc.view.window?.isHidden = true
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 2
        window.frame = CGRect(x: 0, y: 0, width: 466, height: 678)
        window.rootViewController = UIHostingController(rootView: NavigationStack {
            SessionDetailView(sessionId: fixtures.sid).environment(fx.app)
        })
        window.makeKeyAndVisible()
        fixtures.windows.append(window)
        drain(1500)
        func all(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(all) }
        func chat() throws -> UICollectionView {
            try XCTUnwrap(all(window).compactMap { $0 as? UICollectionView }.max { $0.contentSize.height < $1.contentSize.height })
        }
        let cv0 = try chat()
        let vc = try XCTUnwrap(sequence(first: cv0 as UIResponder, next: { $0.next }).first { $0 is ChatPerfListVC } as? ChatPerfListVC)
        let live = ChatUXRegressionTests.Fx(vc: vc, cv: cv0, app: fx.app)
        drag(live, to: cv0.contentSize.height * 0.4)
        let start = try XCTUnwrap(anchor(live))
        for (step, size) in [CGSize(width: 951, height: 669), CGSize(width: 466, height: 678), CGSize(width: 951, height: 669), CGSize(width: 466, height: 678)].enumerated() {
            window.frame = CGRect(origin: .zero, size: size)
            drain(900)
            let cv = try chat()
            XCTAssertTrue(cv === cv0, "step \(step): the same chat list survives the resize")
            XCTAssertLessThanOrEqual(cv.frame.maxX, window.bounds.width + 0.5, "step \(step): list fits the window")
            XCTAssertLessThanOrEqual(overflow(live), 0.5, "step \(step): bubbles laid out for \(Int(size.width)) pt")
            let now = try XCTUnwrap(position(of: start.id, live), "step \(step): the message being read is still on screen")
            XCTAssertEqual(now, start.delta, accuracy: 2, "step \(step): at the same place in the viewport")
            XCTAssertFalse(live.vc.followingBottom, "step \(step): did not jump to the newest message")
        }
    }

    func testAtTheNewestMessageStaysPinnedAcrossWidthChanges() throws {
        let fx = try fixtures.makeFixture(total: 60, onScreen: true)
        resize(fx, CGSize(width: 466, height: 678))
        XCTAssertTrue(fx.vc.followingBottom)
        for size in [CGSize(width: 951, height: 669), CGSize(width: 466, height: 678)] {
            resize(fx, size)
            let bottom = fx.cv.contentSize.height + fx.cv.adjustedContentInset.bottom - fx.cv.bounds.height
            XCTAssertEqual(fx.cv.contentOffset.y, max(bottom, -fx.cv.adjustedContentInset.top), accuracy: 2, "still at the newest message")
            XCTAssertLessThanOrEqual(overflow(fx), 0.5)
        }
    }
}
#endif
