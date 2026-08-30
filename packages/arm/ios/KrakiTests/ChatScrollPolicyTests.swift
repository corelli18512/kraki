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

    func testOlderPageIsConsumedOncePerContinuousInteraction() {
        var policy = ChatScrollPolicy()
        policy.beginUserInteraction(offset: 500, distanceToBottom: 500)
        policy.recordUserIntent(.older, offset: 500, distanceToBottom: 500)

        XCTAssertTrue(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 100,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))
        XCTAssertTrue(policy.olderPageConsumed)
        XCTAssertFalse(policy.olderPageArmed)
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))

        // An overlapping re-grab is still the same interaction.
        policy.beginUserInteraction(offset: 450, distanceToBottom: 550)
        policy.recordUserIntent(.older, offset: 450, distanceToBottom: 550)
        XCTAssertEqual(policy.interactionGeneration, 1)
        XCTAssertFalse(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))

        policy.endUserInteraction()
        policy.beginUserInteraction(offset: 450, distanceToBottom: 550)
        policy.recordUserIntent(.older, offset: 450, distanceToBottom: 550)
        XCTAssertEqual(policy.interactionGeneration, 2)
        XCTAssertTrue(policy.shouldRequestOlderPage(
            distanceToOlderEdge: 0,
            viewportLength: 700,
            hasOlder: true,
            isLoading: false
        ))
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
}
