import XCTest
@testable import Kraki

final class ChatScrollPolicyTests: XCTestCase {
    func testEntryStartsTailLockedWithoutEdgePaging() {
        let policy = ChatScrollPolicy()

        XCTAssertTrue(policy.entryBottomLocked)
        XCTAssertFalse(policy.allowsEdgePaging)
        XCTAssertTrue(policy.followingTail)
        XCTAssertEqual(policy.direction, .none)
        XCTAssertTrue(policy.shouldFollowTail(distanceToBottom: 1_000))
    }

    func testProgrammaticEntryGeometryCannotEnablePaging() {
        var policy = ChatScrollPolicy()

        policy.refreshFollowingTail(distanceToBottom: 400)
        policy.rememberOffset(0)

        XCTAssertTrue(policy.entryBottomLocked)
        XCTAssertFalse(policy.allowsEdgePaging)
        XCTAssertTrue(policy.followingTail)
        XCTAssertFalse(policy.interactionActive)
    }

    func testHarmlessTailGrabPreservesFollowUntilMovement() {
        var policy = ChatScrollPolicy()

        policy.beginUserInteraction(offset: 6_000, distanceToBottom: 0)

        XCTAssertFalse(policy.entryBottomLocked)
        XCTAssertTrue(policy.allowsEdgePaging)
        XCTAssertTrue(policy.followingTail)
        XCTAssertTrue(policy.interactionActive)
        XCTAssertEqual(policy.interactionGeneration, 1)
        XCTAssertEqual(policy.lastObservedOffset, 6_000)
    }

    func testRepeatedUserOwnershipCallbackDoesNotResetMovementBaseline() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 6_000, distanceToBottom: 0)

        policy.unlockForUserInteraction()
        policy.observeUserOffset(5_988, distanceToBottom: 12)

        XCTAssertTrue(policy.scrollingTowardOlder)
        XCTAssertFalse(policy.followingTail)
        XCTAssertTrue(policy.olderPageArmed)
        XCTAssertEqual(policy.lastObservedOffset, 5_988)
    }

    func testFirstOlderMovementWinsOverBottomTolerance() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 6_000, distanceToBottom: 0)

        policy.observeUserOffset(5_988, distanceToBottom: 12)

        XCTAssertTrue(policy.scrollingTowardOlder)
        XCTAssertFalse(policy.followingTail)
        XCTAssertTrue(policy.olderPageArmed)
        XCTAssertFalse(policy.shouldFollowTail(distanceToBottom: 12))
        XCTAssertFalse(policy.isPinnedToTail(distanceToBottom: 12))
    }

    func testStationaryGeometryDoesNotEraseOlderIntent() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 6_000, distanceToBottom: 0)
        policy.observeUserOffset(5_988, distanceToBottom: 12)

        policy.observeUserOffset(5_988.25, distanceToBottom: 4)
        policy.refreshFollowingTail(distanceToBottom: 4)

        XCTAssertTrue(policy.scrollingTowardOlder)
        XCTAssertFalse(policy.followingTail)
        XCTAssertTrue(policy.olderPageArmed)
        XCTAssertFalse(policy.shouldFollowTail(distanceToBottom: 4))
    }

    func testNewerMovementReattachesOnlyInsideTolerance() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 6_000, distanceToBottom: 0)
        policy.observeUserOffset(5_900, distanceToBottom: 100)

        policy.observeUserOffset(5_950, distanceToBottom: 50)
        XCTAssertEqual(policy.direction, .newer)
        XCTAssertFalse(policy.followingTail)

        policy.observeUserOffset(5_980, distanceToBottom: 20)
        XCTAssertTrue(policy.followingTail)
        XCTAssertTrue(policy.shouldFollowTail(distanceToBottom: 20))
    }

    func testReturningToTailKeepsFollowingAcrossStreamingGeometryLag() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 1_000, distanceToBottom: 0)
        policy.observeUserOffset(900, distanceToBottom: 100)
        policy.endUserInteraction()
        policy.beginTailNavigation(offset: 900, distanceToBottom: 100)
        policy.pinToTail(observedOffset: 1_000)
        policy.endNavigation()

        for distance: CGFloat in [18, 33, 90, 400, 0] {
            policy.refreshFollowingTail(distanceToBottom: distance)
            XCTAssertTrue(policy.followingTail, "geometry lag alone is not user intent to leave the tail")
            XCTAssertEqual(policy.direction, .newer)
            XCTAssertFalse(policy.entryBottomLocked)
        }
    }

    func testWheelReturnToTailKeepsFollowingButNewOlderIntentCancelsIt() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 1_000, distanceToBottom: 0)
        policy.observeUserOffset(900, distanceToBottom: 100)
        policy.observeUserOffset(1_000, distanceToBottom: 0)
        policy.endUserInteraction()
        policy.refreshFollowingTail(distanceToBottom: 80)
        XCTAssertTrue(policy.followingTail)

        policy.beginUserInteraction(offset: 1_000, distanceToBottom: 0)
        policy.observeUserOffset(995, distanceToBottom: 5)
        for distance: CGFloat in [5, 0, 100] {
            policy.refreshFollowingTail(distanceToBottom: distance)
            XCTAssertFalse(policy.followingTail, "even a small intentional up-scroll wins")
            XCTAssertEqual(policy.direction, .older)
        }
    }

    func testGeometryDoesNotReattachAnAwayReaderUntilNearTheTail() {
        var policy = ChatScrollPolicy()
        policy.leaveTailForUserNavigation(offset: 500)
        policy.refreshFollowingTail(distanceToBottom: 300)
        XCTAssertFalse(policy.followingTail)
        policy.refreshFollowingTail(distanceToBottom: 24)
        XCTAssertTrue(policy.followingTail)
        policy.refreshFollowingTail(distanceToBottom: 60)
        XCTAssertTrue(policy.followingTail)

        policy.beginLatestMessageStartNavigation()
        policy.refreshFollowingTail(distanceToBottom: 10)
        XCTAssertFalse(policy.followingTail)
    }

    func testUnreadAnchorCannotBeReattachedByTransientNearTailGeometry() {
        var policy = ChatScrollPolicy()
        policy.resetForEntry(unreadBoundary: 41)
        policy.anchorAtFirstUnread(offset: 300)
        for distance: CGFloat in [0, 12, 33, 500] {
            policy.refreshFollowingTail(distanceToBottom: distance)
            XCTAssertFalse(policy.followingTail, "the unread landing owns the viewport until explicitly released")
            XCTAssertEqual(policy.unreadEntry, .anchored)
        }
        policy.releaseUnreadAnchor(boundary: 41)
        policy.refreshFollowingTail(distanceToBottom: 100)
        XCTAssertTrue(policy.followingTail)
        XCTAssertEqual(policy.unreadEntry, .armed(boundary: 41))
    }

    func testOlderPagingContinuesWithFurtherOlderMovement() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 500, distanceToBottom: 500)
        policy.recordUserIntent(.older, offset: 500, distanceToBottom: 500)

        XCTAssertTrue(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 100, viewportLength: 700, hasOlder: true, isLoading: false))
        XCTAssertFalse(policy.olderPageArmed)
        // No new user movement: the request is not repeated (no self-chaining).
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0, viewportLength: 700, hasOlder: true, isLoading: false))
        // Programmatic compensation after the prepend moves toward newer: no re-arm.
        policy.observeUserOffset(1_400, distanceToBottom: 500)
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 900, viewportLength: 700, hasOlder: true, isLoading: false))
        // The same continuous gesture keeps moving toward older: next page.
        policy.observeUserOffset(1_300, distanceToBottom: 600)
        XCTAssertEqual(policy.interactionGeneration, 1)
        XCTAssertTrue(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 800, viewportLength: 700, hasOlder: true, isLoading: false))
        // Wheel intent at the top edge (offset cannot move) also re-arms.
        policy.recordUserIntent(.older, offset: 0, distanceToBottom: 900)
        XCTAssertTrue(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0, viewportLength: 700, hasOlder: true, isLoading: false))
    }

    func testOlderPageRequiresDirectionAvailabilityAndPrefetchBand() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 2_000, distanceToBottom: 0)
        policy.recordUserIntent(.older, offset: 2_000, distanceToBottom: 0)
        let threshold = policy.olderPrefetchDistance(viewportLength: 700)

        XCTAssertEqual(threshold, 1_400)
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: threshold + 1,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 100,
            viewportLength: 700,
            hasOlder: false,
            isLoading: false
        ))
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 100,
            viewportLength: 700,
            hasOlder: true,
            isLoading: true
        ))
        XCTAssertTrue(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 100,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))
    }

    func testOlderRequestSuppressesNewerUntilExplicitNewerIntent() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 100, distanceToBottom: 100)
        policy.recordUserIntent(.older, offset: 100, distanceToBottom: 100)
        XCTAssertTrue(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))

        XCTAssertFalse(policy.shouldRequestNewerPage(
            distanceToNewerEdge: 0,
            hasNewer: true,
            isLoading: false
        ))
        policy.recordUserIntent(.newer, offset: 200, distanceToBottom: 10)
        XCTAssertTrue(policy.shouldRequestNewerPage(
            distanceToNewerEdge: 10,
            hasNewer: true,
            isLoading: false
        ))
        XCTAssertFalse(policy.shouldRequestNewerPage(
            distanceToNewerEdge: ChatScrollPolicy.edgeTriggerDistance + 1,
            hasNewer: true,
            isLoading: false
        ))
    }

    func testLatestMessageStartNavigationSuppressesPagingAndControls() {
        var policy = ChatScrollPolicy()

        policy.beginLatestMessageStartNavigation()

        XCTAssertFalse(policy.entryBottomLocked)
        XCTAssertTrue(policy.allowsEdgePaging)
        XCTAssertTrue(policy.scrollingTowardOlder)
        XCTAssertFalse(policy.followingTail)
        XCTAssertTrue(policy.navigationActive)
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))
        XCTAssertEqual(
            policy.navigationControlVisibility(
                distanceToBottom: 2_000,
                viewportLength: 700,
                hasUnloadedNewer: true,
                currentOffset: 0,
                latestMessageStartOffset: 500
            ),
            .init(showTail: false, showLatestMessageStart: false)
        )

        policy.endNavigation()
        XCTAssertFalse(policy.navigationActive)
    }

    func testTailNavigationSuppressesPagingUntilItLands() {
        var policy = ChatScrollPolicy()

        policy.beginTailNavigation(offset: 100, distanceToBottom: 900)

        XCTAssertEqual(policy.direction, .newer)
        XCTAssertFalse(policy.followingTail)
        XCTAssertTrue(policy.suppressesEdgePaging)
        policy.pinToTail(observedOffset: 1_000)
        XCTAssertTrue(policy.followingTail)
        XCTAssertTrue(policy.navigationActive)
        policy.endNavigation()
        XCTAssertFalse(policy.navigationActive)
    }

    func testNavigationControlVisibilityUsesSharedThresholds() {
        let policy = ChatScrollPolicy()

        XCTAssertEqual(
            policy.navigationControlVisibility(
                distanceToBottom: 1_051,
                viewportLength: 700,
                hasUnloadedNewer: false,
                currentOffset: 100,
                latestMessageStartOffset: 125
            ),
            .init(showTail: true, showLatestMessageStart: true)
        )
        XCTAssertEqual(
            policy.navigationControlVisibility(
                distanceToBottom: 1_050,
                viewportLength: 700,
                hasUnloadedNewer: false,
                currentOffset: 100,
                latestMessageStartOffset: 124
            ),
            .init(showTail: false, showLatestMessageStart: false)
        )
    }

    func testPinToTailClearsOlderIntentWithoutReleasingEntryLock() {
        var policy = ChatScrollPolicy()

        policy.pinToTail(observedOffset: 900)

        XCTAssertTrue(policy.entryBottomLocked)
        XCTAssertFalse(policy.allowsEdgePaging)
        XCTAssertFalse(policy.scrollingTowardOlder)
        XCTAssertTrue(policy.followingTail)
        XCTAssertEqual(policy.lastObservedOffset, 900)
    }

    func testExplicitTailPinAfterUserNavigationKeepsPagingEnabled() {
        var policy = ChatScrollPolicy()
        policy.beginLatestMessageStartNavigation()
        policy.endNavigation()

        policy.pinToTail(observedOffset: 1_200)

        XCTAssertFalse(policy.entryBottomLocked)
        XCTAssertTrue(policy.allowsEdgePaging)
        XCTAssertTrue(policy.followingTail)
        XCTAssertFalse(policy.scrollingTowardOlder)
    }

    func testResetRestoresFreshSessionState() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 300, distanceToBottom: 100)
        policy.recordUserIntent(.older, offset: 300, distanceToBottom: 100)
        _ = policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        )
        policy.beginLatestMessageStartNavigation()

        policy.resetForEntry()

        XCTAssertEqual(policy, ChatScrollPolicy())
    }

    // MARK: Unread entry (red dot / notification)

    func testFirstUnreadRowIsTheLowestSeqAfterTheReadPosition() {
        let rows: [(id: String, seq: Int?)] = [("a", 10), ("b", 11), ("live", nil), ("c", 12)]
        XCTAssertEqual(ChatScrollPolicy.firstUnreadRow(rows, after: 10), "b")
        XCTAssertNil(ChatScrollPolicy.firstUnreadRow(rows, after: 12), "nothing new loaded: stay at the tail")
        XCTAssertNil(ChatScrollPolicy.firstUnreadRow([("live", nil)], after: 0))
    }

    func testLandsOnTheFirstUnreadOnlyWhenItsStartIsNotReadableAtTheTail() {
        // The new part fits: its start lands at or below the tail offset.
        XCTAssertNil(ChatScrollPolicy.unreadEntryLanding(rowStartLanding: 900, tailOffset: 900))
        XCTAssertNil(ChatScrollPolicy.unreadEntryLanding(rowStartLanding: 899.5, tailOffset: 900))
        // Longer than a screen: land on its start.
        XCTAssertEqual(ChatScrollPolicy.unreadEntryLanding(rowStartLanding: 400, tailOffset: 900), 400)
    }

    func testUnreadEntryIsArmedOnlyForThatEntryAndEndsWithTheUser() {
        var policy = ChatScrollPolicy()
        XCTAssertEqual(policy.unreadEntry, .none)
        policy.resetForEntry(unreadBoundary: 41)
        XCTAssertEqual(policy.unreadEntryBoundary, 41)
        XCTAssertTrue(policy.entryBottomLocked)

        policy.anchorAtFirstUnread(offset: 300)
        XCTAssertEqual(policy.unreadEntry, .anchored)
        XCTAssertFalse(policy.entryBottomLocked, "held at the first new message, not the tail")
        XCTAssertFalse(policy.followingTail, "new arrivals must not pull the reader away")
        XCTAssertFalse(policy.shouldFollowTail(distanceToBottom: 900))
        XCTAssertFalse(policy.allowsEdgePaging, "no paging until the user scrolls")

        policy.observeUserOffset(310, distanceToBottom: 800)
        XCTAssertEqual(policy.unreadEntry, .none)
        XCTAssertTrue(policy.allowsEdgePaging)

        policy.resetForEntry(unreadBoundary: nil)
        XCTAssertEqual(policy.unreadEntry, .none, "a read Session opens at the tail")
    }

    func testSendingOrGoingToTheTailCancelsTheUnreadLanding() {
        var policy = ChatScrollPolicy()
        policy.resetForEntry(unreadBoundary: 5)
        policy.cancelUnreadEntry()
        XCTAssertNil(policy.unreadEntryBoundary)
        policy.resetForEntry(unreadBoundary: 5)
        policy.beginTailNavigation(offset: 0, distanceToBottom: 500)
        XCTAssertEqual(policy.unreadEntry, .none)
        policy.resetForEntry(unreadBoundary: 5)
        policy.beginLatestMessageStartNavigation()
        XCTAssertEqual(policy.unreadEntry, .none)
    }
}
