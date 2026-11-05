import XCTest
import SwiftUI
@testable import Kraki

#if os(iOS)
/// The iOS Session list: archived-row swipes, midnight time labels and the
/// empty-state arrow.
@MainActor
final class SessionTableTests: XCTestCase {
    /// K-338: a sideways swipe on an archived row is claimed (so it is not
    /// ended as a tap that opens and unarchives it); live rows keep their
    /// swipe actions and vertical drags still scroll.
    func testOnlySidewaysSwipesOnArchivedRowsAreClaimed() {
        let archived = SessionTableController.archivedPrefix + "s1"
        XCTAssertTrue(SessionTableController.claimsSwipe(onItem: archived, velocity: CGPoint(x: -600, y: 40)))
        XCTAssertTrue(SessionTableController.claimsSwipe(onItem: archived, velocity: CGPoint(x: 300, y: -20)))
        XCTAssertFalse(SessionTableController.claimsSwipe(onItem: archived, velocity: CGPoint(x: 30, y: 500)))
        XCTAssertFalse(SessionTableController.claimsSwipe(onItem: "s1", velocity: CGPoint(x: -600, y: 0)))
        XCTAssertFalse(SessionTableController.claimsSwipe(onItem: SessionTableController.archivedHeaderId,
                                                           velocity: CGPoint(x: -600, y: 0)))
        XCTAssertFalse(SessionTableController.claimsSwipe(onItem: nil, velocity: CGPoint(x: -600, y: 0)))
    }

    /// K-339: at midnight the list rebuilds its rows ("14:05" → "yesterday"),
    /// although no Session changed.
    func testDayChangeRebuildsRows() throws {
        let app = AppState.makeUnitTestHost()
        app.sessionStore.upsertSession(SessionInfo(
            id: "s1", deviceId: "d", deviceName: "D", agent: "pi", title: "One",
            state: .idle, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1,
            createdAt: Date(), pinned: false))
        let controller = SessionTableController()
        controller.appState = app
        controller.onCellTapped = { _ in }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        let table = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UITableView }.first)
        XCTAssertEqual(controller.timeLabelEpoch, 0)

        NotificationCenter.default.post(name: UIApplication.significantTimeChangeNotification, object: nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        // The rows are keyed by this epoch (`.id`), so their cards are built
        // again and read the clock.
        XCTAssertEqual(controller.timeLabelEpoch, 1)
        XCTAssertNotNil(table.cellForRow(at: IndexPath(row: 0, section: 0)), "the row is still shown")
    }

    /// K-341: the empty-state arrow points at the New Session tab only where
    /// that tab is at the bottom-right (portrait iPhone).
    func testEmptyStateArrowOnlyOnPortraitIPhone() {
        XCTAssertTrue(SessionListView.showsNewSessionArrow(horizontal: .compact, vertical: .regular))
        XCTAssertFalse(SessionListView.showsNewSessionArrow(horizontal: .compact, vertical: .compact), "iPhone landscape")
        XCTAssertFalse(SessionListView.showsNewSessionArrow(horizontal: .regular, vertical: .compact), "Pro Max landscape")
        XCTAssertFalse(SessionListView.showsNewSessionArrow(horizontal: .regular, vertical: .regular), "iPad")
    }
}
#endif
