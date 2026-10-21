import AppKit
import XCTest
@testable import Kraki_Dev

@MainActor
final class MacUnderfilledHistoryTests: MacChatListTestCase {
    func testShortStoppedTailLoadsOlderWithoutScrollingUntilViewportFills() async throws {
        let fx = try await fixture(total: 120, stopped: true, height: 1_100)
        await settle(fx)
        let state = try XCTUnwrap(fx.app.messageStore.windowState(sid))
        XCTAssertLessThan(state.topSeq, 106, "the initial 15 raw rows must expand without a scroll")
        let frames = fx.sv.chatDocumentView.itemFrames
        let first = try XCTUnwrap(frames.first), last = try XCTUnwrap(frames.last)
        XCTAssertGreaterThan(last.maxY - first.minY,
                             fx.sv.contentView.bounds.height - fx.sv.topContentInset - fx.sv.chatDocumentView.bottomSafeArea)
        XCTAssertFalse(fx.sv.hasUserScrolled)
        XCTAssertFalse(fx.sv.diagnosticAtOldest, "stop once filled, rather than eagerly loading all history")
        XCTAssertEqual(state.bottomSeq, 120, "keep the tail window")
        XCTAssertLessThanOrEqual(fx.sv.distanceToBottom, 1, "keep the tail anchor across prepends")
        let top = state.topSeq
        await settle(fx)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, top, "a filled viewport does not keep fetching")
    }

    func testShortStoppedTailReachesHistoryStartAndRemovesSpinnerWithoutScrolling() async throws {
        let fx = try await fixture(total: 18, stopped: true, height: 1_100)
        await settle(fx)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, 1)
        XCTAssertTrue(fx.sv.diagnosticAtOldest)
        XCTAssertFalse(fx.sv.chatDocumentView.showsOlderSpinner)
        XCTAssertTrue(fx.sv.chatDocumentView.topSpinner.isHidden)
        XCTAssertFalse(fx.sv.hasUserScrolled)
        XCTAssertLessThanOrEqual(fx.sv.distanceToBottom, 1)
    }

    func testFilledTailDoesNotLoadOlderWithoutScrolling() async throws {
        let fx = try await fixture(total: 60)
        await settle(fx)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, 46)
        XCTAssertFalse(fx.sv.hasUserScrolled)
    }

    func testUnderfilledHistoryWaitsForNavigationToFinish() async throws {
        let fx = try await fixture(total: 120, stopped: true, height: 400)
        await settle(fx)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, 106)
        fx.sv.scrollPolicy.beginLatestMessageStartNavigation()
        fx.window.setContentSize(NSSize(width: 900, height: 1_100))
        await settle(fx)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, 106, "do not compete with navigation")
        fx.sv.scrollPolicy.endNavigation()
        fx.sv.updateJumpButtonVisibility(animated: false)
        await settle(fx)
        XCTAssertLessThan(try XCTUnwrap(fx.app.messageStore.windowState(sid)).topSeq, 106)
    }

    func testUnderfilledHistoryStopsAfterEightPagesButUserPagingStillWorks() async throws {
        let fx = try await fixture(total: 300, stopped: true, height: 8_000)
        await settle(fx)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, 206, "15 initial rows plus eight 10-row pages")
        XCTAssertFalse(fx.sv.diagnosticAtOldest)
        XCTAssertFalse(fx.sv.hasUserScrolled)
        await settle(fx)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, 206, "the automatic fill is bounded")
        _ = fx.sv.automationPreciseScrollPacket(deltaY: 40)
        await settle(fx)
        XCTAssertLessThan(try XCTUnwrap(fx.app.messageStore.windowState(sid)).topSeq, 206,
                          "the automatic budget does not consume normal scroll-driven paging")
    }
}
